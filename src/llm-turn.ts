import { parentPaper } from "./library";
import { readNativePrompt } from "../shared/question";

const standaloneChat = ".llm-standalone-content #llm-main";

function markdown(node: Node): string {
  if (node.nodeType === 3) return node.textContent || "";
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  if (element.matches("button, script, style, .llm-web-source-indicator, .llm-quote-card-citation")) return "";
  if (element.matches(".katex")) {
    const latex = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (latex) return `$${latex}$`;
  }
  const text = Array.from(element.childNodes, markdown).join("");
  const tag = element.localName;
  if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${text.trim()}\n\n`;
  switch (tag) {
    case "p": return `\n\n${text.trim()}\n\n`;
    case "br": return "\n";
    case "strong":
    case "b": return `**${text}**`;
    case "em":
    case "i": return `*${text}*`;
    case "code": return element.parentElement?.localName === "pre" ? text : `\`${text}\``;
    case "pre": {
      const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length + 1)));
      return `\n\n${fence}\n${text.trimEnd()}\n${fence}\n\n`;
    }
    case "ul":
    case "ol": return `\n${text.trim()}\n\n`;
    case "li": return `${element.parentElement?.localName === "ol" ? "1." : "-"} ${text.trim()}\n`;
    case "blockquote": return `\n\n${text.trim().split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    case "a": {
      const href = element.getAttribute("href") || "";
      return /^https?:\/\/[^\s<>]+$/i.test(href) ? `[${text}](<${href}>)` : text;
    }
    default: return text;
  }
}

function pdfSources(answer: Element) {
  const matches = new Map<string, { attachmentID: number; pageIndex: number }>();
  answer.querySelectorAll<HTMLAnchorElement>('a[href^="zotero://open-pdf/"]').forEach((link) => {
    if (matches.size === 30) return;
    const href = link.getAttribute("href") || "";
    const match = /^zotero:\/\/open-pdf\/(library|groups\/(\d+))\/items\/([A-Z0-9]{8})\?/.exec(href);
    if (!match) return;
    const page = Number(new URLSearchParams(href.slice(match[0].length)).get("page"));
    if (!Number.isSafeInteger(page) || page < 1) return;
    const libraryID = match[2] ? Zotero.Groups.get(Number(match[2]))?.libraryID : Zotero.Libraries.userLibraryID;
    if (!libraryID) return;
    const attachment = Zotero.Items.getByLibraryAndKey(libraryID, match[3]);
    if (!attachment || !attachment.isPDFAttachment()) return;
    matches.set(`${attachment.id}:${page}`, { attachmentID: attachment.id, pageIndex: page - 1 });
  });
  return [...matches.values()];
}

export function conversationAt(container: Element, itemID: number) {
  const doc = container.ownerDocument;
  const local = container.closest<HTMLElement>("#llm-main");
  const chat = local?.isConnected ? local : doc.querySelector<HTMLElement>(standaloneChat);
  const key = Number(chat?.dataset.itemId);
  const paperID = Number(chat?.dataset.basePaperItemId || key);
  if (chat?.dataset.conversationKind !== "paper" || !Number.isSafeInteger(key) || key < 1 ||
      !Number.isSafeInteger(paperID) || paperID < 1 ||
      parentPaper(Zotero.Items.get(paperID))?.id !== itemID) return;
  return { chat, key };
}

export function askConversation(container: Element, itemID: number, key: number, prompt: string) {
  const current = conversationAt(container, itemID);
  if (current?.key !== key) throw new Error("当前论文对话已切换。请重新打开提问框。");
  const input = current.chat.querySelector<HTMLTextAreaElement>("#llm-input");
  const send = current.chat.querySelector<HTMLButtonElement>("#llm-send");
  if (!container.isConnected || !input || !send || input.disabled || input.readOnly ||
      input.closest('[data-message-role="user"]')) throw new Error("请先结束论文对话中的当前操作。");
  if (input.value) throw new Error("论文对话中有未发送的草稿，请先处理草稿。");
  if (current.chat.querySelector(".llm-bubble.streaming, .llm-typing")) {
    throw new Error("请等当前回答生成完毕。");
  }
  const win = input.ownerDocument.defaultView!;
  input.value = prompt;
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
  if (send.disabled || send.hidden) {
    input.value = "";
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
    throw new Error("论文对话现在无法发送，请检查 LLM for Zotero 的输入栏。");
  }
  send.click();
}

export function observeConversation(
  container: Element, itemID: number, update: (key: number, turns: ReadTurn[], partial: boolean) => void,
) {
  const doc = container.ownerDocument;
  const win = doc.defaultView!;
  let timer: number | undefined;
  let fingerprint: string | undefined;
  function sync() {
    timer = undefined;
    const current = conversationAt(container, itemID);
    if (!current) {
      if (fingerprint !== "") update(0, [], false);
      fingerprint = "";
      return;
    }
    const { chat, key } = current;
    const turns: ReadTurn[] = [];
    const messages = Array.from(chat.querySelector("#llm-chat-box")?.children ?? []) as HTMLElement[];
    const firstMessage = messages.find((message) => message.dataset.messageIndex !== undefined);
    const partial = Boolean(firstMessage && Number(firstMessage.dataset.messageIndex) > 0);
    let user: Element | undefined;
    let userIndex = -1;
    for (const message of messages) {
      if (message.dataset.messageRole === "user") {
        user = message.querySelector(".llm-bubble.user") ?? undefined;
        userIndex = Number(message.dataset.messageIndex);
        continue;
      }
      if (message.dataset.messageRole !== "assistant" || !user ||
          message.classList.contains("llm-compact-marker-wrapper") ||
          Number(message.dataset.messageIndex) !== userIndex + 1 ||
          message.querySelector(".llm-bubble.streaming, .llm-typing")) continue;
      const copy = message.querySelector<HTMLElement>(".llm-message-action-copy[data-conversation-key]");
      if (copy && Number(copy.dataset.conversationKey) !== key) continue;
      const timestamp = Number(copy?.dataset.assistantTimestamp || message.dataset.messageTimestamp);
      if (!Number.isSafeInteger(timestamp) || timestamp < 1) continue;
      const blocks = [...message.querySelectorAll<HTMLElement>(".llm-assistant-answer, .llm-agent-inline-text")] as HTMLElement[];
      const answer = blocks.map(markdown).join("\n\n").trim().slice(0, 65000);
      if (!answer) continue;
      const stopped = /^\[(?:Cancelled|Canceled|Aborted|已取消)\]$/i.test(answer);
      const { question, branchID } = readNativePrompt(user.textContent || "");
      turns.push({
        timestamp, stopped, branchID,
        question: question.slice(0, 20000),
        answer: stopped ? "" : answer,
        sources: blocks.flatMap(pdfSources).slice(0, 30),
      });
    }
    const next = JSON.stringify([key, partial, turns]);
    if (fingerprint !== next) {
      fingerprint = next;
      update(key, turns, partial);
    }
  }

  const observer = new win.MutationObserver((mutations) => {
    if (timer !== undefined || !mutations.some(({ target, addedNodes, removedNodes }) => {
      const element = target.nodeType === 1 ? target as Element : target.parentElement;
      return element?.matches("#llm-main") || !!element?.closest("#llm-chat-box") ||
        [...addedNodes, ...removedNodes].some((node) => node?.nodeType === 1 &&
          ((node as Element).matches("#llm-main") || (node as Element).querySelector("#llm-main")));
    })) return;
    timer = win.setTimeout(sync, 120);
  });
  observer.observe(doc.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["data-item-id", "data-base-paper-item-id", "data-conversation-kind", "class"],
  });
  sync();
  return () => {
    observer.disconnect();
    win.clearTimeout(timer);
  };
}

type ReadTurn = {
  timestamp: number;
  branchID?: string;
  question: string;
  answer: string;
  sources: ReturnType<typeof pdfSources>;
  stopped: boolean;
};
