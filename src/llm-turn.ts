import { parentPaper } from "./library";
import { readNativePrompt } from "../shared/question";

const standaloneChat = ".llm-standalone-content #llm-main";

function markdown(node: Node, citation?: (mark: Element) => string): string {
  if (node.nodeType === 3) return node.textContent || "";
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  if (element.matches(".llm-paper-cite-mark")) return citation?.(element) ?? "";
  if (element.matches("button, script, style, .llm-web-source-indicator, .llm-quote-card-citation")) return "";
  if (element.matches(".katex")) {
    const latex = element.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    if (latex) return `$${latex}$`;
  }
  const text = ([...element.childNodes] as Node[]).map((child) => markdown(child, citation)).join("");
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

function answerBlocks(message: Element) {
  return [...message.querySelectorAll(".llm-assistant-answer, .llm-agent-inline-text")] as Element[];
}

export function answerMarkdown(blocks: Element[], citation?: (mark: Element) => string) {
  return blocks.map((block) => markdown(block, citation)).join("\n\n").trim().slice(0, 65000);
}

function assistantTimestamp(message: HTMLElement, key: number) {
  const copy = message.querySelector<HTMLElement>(".llm-message-action-copy[data-conversation-key]");
  if (copy && Number(copy.dataset.conversationKey) !== key) return;
  const timestamp = Number(copy?.dataset.assistantTimestamp || message.dataset.messageTimestamp);
  if (Number.isSafeInteger(timestamp) && timestamp > 0) return timestamp;
}

export function answerForTurn(container: Element, itemID: number, turnID: string) {
  const current = conversationAt(container, itemID);
  if (!current || !turnID.startsWith(`${current.key}:`)) return [];
  const messages = [...current.chat.querySelectorAll('#llm-chat-box > [data-message-role="assistant"]')] as HTMLElement[];
  const message = messages
    .find((node) => `${current.key}:${assistantTimestamp(node, current.key)}` === turnID &&
      !node.querySelector(".llm-bubble.streaming, .llm-typing"));
  return message ? answerBlocks(message) : [];
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

export function readTurnOutcome(
  chat: HTMLElement, previousMax: number, expectedUserIndex?: number,
): { state: "pending" } | { state: "done"; answer: string; stopped: boolean } {
  const box = chat.querySelector("#llm-chat-box");
  if (!box || chat.querySelector(".llm-bubble.streaming, .llm-typing") ||
      box.querySelector('[data-message-role="user"] #llm-input')) {
    return { state: "pending" };
  }
  const messages = Array.from(box.children) as HTMLElement[];
  const targetUser = expectedUserIndex !== undefined
    ? messages.find((node) => node.dataset.messageRole === "user" && Number(node.dataset.messageIndex) === expectedUserIndex)
    : messages.findLast((node) => {
      const idx = Number(node.dataset.messageIndex);
      return node.dataset.messageRole === "user" && Number.isSafeInteger(idx) && idx > previousMax;
    });
  if (!targetUser) return { state: "pending" };
  const userIndex = Number(targetUser.dataset.messageIndex);
  const assistant = messages.find((node) =>
    node.dataset.messageRole === "assistant" &&
    !node.classList.contains("llm-compact-marker-wrapper") &&
    Number(node.dataset.messageIndex) === userIndex + 1 &&
    !node.querySelector(".llm-bubble.streaming, .llm-typing"));
  if (!assistant) return { state: "pending" };
  const answer = answerMarkdown(answerBlocks(assistant));
  if (!answer) return { state: "pending" };
  const stopped = /^\[(?:Cancelled|Canceled|Aborted|已取消)\]$/i.test(answer);
  return { state: "done", answer: stopped ? "" : answer, stopped };
}

function readModelQuotes(message: HTMLElement) {
  const quotes: string[] = [];
  const inlineQuestions: string[] = [];
  const seen = new Set<string>();
  const addQuote = (raw: string | null | undefined) => {
    const text = (raw || "").trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    quotes.push(text.slice(0, 10000));
  };
  const bars = Array.from(message.querySelectorAll('.llm-user-selected-text[data-context-source="model"]')) as HTMLElement[];
  for (const bar of bars) {
    const index = bar.dataset.contextIndex;
    const expanded = index !== undefined
      ? message.querySelector(`.llm-user-selected-text-expanded[data-context-index="${index}"]`)
      : null;
    addQuote(expanded?.textContent || bar.querySelector(".llm-user-selected-text-content")?.textContent);
  }
  const cards = Array.from(message.querySelectorAll('.llm-user-selected-text-expanded[data-context-source="model"]')) as HTMLElement[];
  for (const card of cards) {
    addQuote(card.querySelector(".llm-selected-context-text")?.textContent);
    const q = card.querySelector(".llm-selected-context-question")?.textContent?.trim();
    if (q) inlineQuestions.push(q);
  }
  return { quotes, inlineQuestions };
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
    const box = chat.querySelector("#llm-chat-box");
    const messages = Array.from(box?.children ?? []) as HTMLElement[];
    const firstMessage = messages.find((message) => message.dataset.messageIndex !== undefined);
    const renderedUsers = messages.filter((message) => message.dataset.messageRole === "user").length;
    const expectedUsers = chat.querySelectorAll(".llm-turn-navigator-marker").length;
    const partial = !box || Number(firstMessage?.dataset.messageIndex) > 0 ||
      expectedUsers > renderedUsers ||
      !!box.querySelector('[data-message-role="user"] #llm-input, .llm-bubble.streaming, .llm-typing');
    let user: Element | undefined;
    let userIndex = -1;
    let userQuotes: string[] = [];
    let userInlineQuestions: string[] = [];
    for (const message of messages) {
      if (message.dataset.messageRole === "user") {
        user = message.querySelector(".llm-bubble.user") ?? undefined;
        userIndex = Number(message.dataset.messageIndex);
        const extracted = readModelQuotes(message);
        userQuotes = extracted.quotes;
        userInlineQuestions = extracted.inlineQuestions;
        continue;
      }
      if (message.dataset.messageRole !== "assistant" || (!user && !userInlineQuestions.length) ||
          message.classList.contains("llm-compact-marker-wrapper") ||
          Number(message.dataset.messageIndex) !== userIndex + 1 ||
          message.querySelector(".llm-bubble.streaming, .llm-typing")) continue;
      const timestamp = assistantTimestamp(message, key);
      if (!timestamp) continue;
      const blocks = answerBlocks(message);
      const answer = answerMarkdown(blocks);
      if (!answer) continue;
      const stopped = /^\[(?:Cancelled|Canceled|Aborted|已取消)\]$/i.test(answer);
      const rawPrompt = (user?.textContent || "").trim() || userInlineQuestions.join("\n\n");
      const { question, branchID } = readNativePrompt(rawPrompt);
      turns.push({
        timestamp, messageIndex: userIndex, stopped, branchID,
        quotedTexts: userQuotes.length ? userQuotes : undefined,
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
    if (timer !== undefined || !mutations.some(({ type, target, addedNodes, removedNodes }) => {
      const element = target.nodeType === 1 ? target as Element : target.parentElement;
      return element?.matches("#llm-main") || !!element?.closest("#llm-chat-box") ||
        (type === "childList" && !!element?.closest(".llm-turn-navigator-list")) ||
        [...addedNodes, ...removedNodes].some((node) => node?.nodeType === 1 &&
          ((node as Element).matches("#llm-main") || (node as Element).querySelector("#llm-main")));
    })) return;
    timer = win.setTimeout(sync, 120);
  });
  observer.observe(doc.documentElement, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: [
      "data-item-id", "data-base-paper-item-id", "data-conversation-kind",
      "data-message-index", "data-message-timestamp", "data-assistant-timestamp", "class",
    ],
  });
  sync();
  return () => {
    observer.disconnect();
    win.clearTimeout(timer);
  };
}

type ReadTurn = {
  timestamp: number;
  messageIndex: number;
  branchID?: string;
  quotedTexts?: string[];
  question: string;
  answer: string;
  sources: ReturnType<typeof pdfSources>;
  stopped: boolean;
};
