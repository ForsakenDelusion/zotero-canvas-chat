import { errorMessage, type Command } from "../shared/schema";
import { questionSuggestions } from "../shared/question";
import { conversationAt, readTurnOutcome } from "./llm-turn";
import type { CanvasSession, NativeBranchSubmission } from "./session";

type Open = Extract<Command, { type: "openComposer" }>;
type HostWindow = Window & typeof globalThis;
type Conversation = ReturnType<typeof conversationAt>;
const namespace = "http://www.w3.org/1999/xhtml";
const menus = [
  ["#llm-runtime-menu", "#llm-runtime-mode-toggle"],
  ["#llm-model-menu", "#llm-model-toggle"],
  ["#llm-reasoning-menu", "#llm-reasoning-toggle"],
  ["#llm-slash-menu", "#llm-upload-file"],
] as const;
const historyNavigation = [
  ".llm-standalone-sidebar .llm-standalone-conv-item", ".llm-standalone-nav-new-chat", ".llm-standalone-search-item",
  "#llm-history-new", "#llm-history-new-menu button", "#llm-history-menu .llm-history-menu-row-main",
].join(", ");

const styles = `
  .llm-standalone-content-wrapper { overflow: visible; }
  .llm-standalone-content-wrapper:not([data-zcanvas-workspace]) { z-index: 6000; }
  #llm-main > .llm-input-section[data-zcanvas-composer] {
    position: fixed !important; display: flex !important; inset: auto !important;
    left: var(--zcanvas-left) !important; top: var(--zcanvas-top) !important;
    width: var(--zcanvas-width) !important; max-width: none !important;
    margin: 0 !important; padding: 8px; box-sizing: border-box; z-index: 6000 !important;
    border-radius: 11px; box-shadow: 0 4px 18px #0002;
  }
  [data-zcanvas-composer] .llm-chat-shell-resize-handle { display: none !important; }
  [data-zcanvas-composer] .llm-actions-left { flex-wrap: wrap; }
  [data-zcanvas-composer] .llm-context-previews { max-height: min(135px, 25vh); }
  [data-zcanvas-composer] .zcanvas-composer-head { display: flex; gap: 6px; align-items: center; min-width: 0; font-size: 12px; }
  [data-zcanvas-composer] .zcanvas-composer-head span { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  [data-zcanvas-composer] .zcanvas-composer-head button,
  [data-zcanvas-composer] .zcanvas-composer-suggestions button {
    border: 0; border-radius: 6px; padding: 4px 6px; background: transparent; color: inherit; font: inherit; cursor: pointer;
  }
  [data-zcanvas-composer] .zcanvas-composer-head button:hover,
  [data-zcanvas-composer] .zcanvas-composer-suggestions button:hover { background: var(--fill-quinary); }
  .zcanvas-composer-quote { max-height: 3.4em; overflow: auto; margin: 0; padding: 2px 7px; border-inline-start: 2px solid var(--stroke-secondary); font-size: 11px; overflow-wrap: anywhere; }
  .zcanvas-composer-suggestions { display: flex; flex-wrap: wrap; font-size: 11px; color: var(--fill-secondary); }
  .zcanvas-composer-error:empty { display: none; }
  .zcanvas-composer-error { font-size: 12px; color: var(--fill-primary); overflow-wrap: anywhere; }
  #llm-main [data-zcanvas-menu] {
    position: fixed !important; left: var(--zcanvas-left) !important;
    top: var(--zcanvas-top) !important; max-width: var(--zcanvas-width) !important;
    z-index: 6001 !important;
  }
`;

function html(doc: Document, tag: "button"): HTMLButtonElement;
function html(doc: Document, tag: string): HTMLElement;
function html(doc: Document, tag: string) {
  return doc.createElementNS(namespace, tag) as HTMLElement;
}

function position(element: HTMLElement, left: number, top: number, width: number) {
  for (const [key, value] of Object.entries({ left, top, width })) {
    const property = `--zcanvas-${key}`;
    const pixels = `${Math.round(value)}px`;
    if (element.style.getPropertyValue(property) !== pixels) element.style.setProperty(property, pixels);
  }
}

export function nativeComposer(container: Element, iframe: HTMLIFrameElement, itemID: number, session: CanvasSession,
  closed: (request: string, draft: string) => void, runtimeChanged: (from: number, to: number) => void) {
  const doc = container.ownerDocument;
  const win = doc.defaultView as HostWindow;
  let active: { close(): void; request: string } | undefined;
  let runtimeSwitch: { from: number; system: string; timer: number; resume: (key?: number) => void } | undefined;

  function clearRuntimeSwitch() {
    if (runtimeSwitch) win.clearTimeout(runtimeSwitch.timer);
    runtimeSwitch = undefined;
  }

  function canSync(next: Conversation) {
    const switching = runtimeSwitch;
    if (!switching) return true;
    if (next?.chat.dataset.conversationSystem !== switching.system) return false;
    const toggle = next.chat.querySelector<HTMLElement>("#llm-runtime-mode-toggle");
    if (!toggle || toggle.dataset.switching === "true") return false;
    clearRuntimeSwitch();
    if (next.key !== switching.from) runtimeChanged(switching.from, next.key);
    switching.resume(next.key);
    return true;
  }

  const locate = () => {
    const current = conversationAt(container, itemID);
    const section = current?.chat.querySelector<HTMLElement>(":scope > .llm-input-section");
    const input = section?.querySelector<HTMLTextAreaElement>("#llm-input");
    const send = section?.querySelector<HTMLButtonElement>("#llm-send");
    return current && section && input && send && !input.disabled && !input.readOnly
      ? { ...current, section, input, send } : undefined;
  };
  type Target = NonNullable<ReturnType<typeof locate>>;

  function write(input: HTMLTextAreaElement, text: string) {
    input.value = text;
    input.dispatchEvent(new win.Event("input", { bubbles: true }));
  }

  function userIndices(chat: HTMLElement) {
    return (Array.from(chat.querySelectorAll('#llm-chat-box > [data-message-role="user"]')) as HTMLElement[])
      .map((node) => Number(node.dataset.messageIndex))
      .filter((index) => Number.isSafeInteger(index) && index >= 0);
  }

  function attachFiles(target: Target, files: File[]) {
    const transfer = new win.DataTransfer();
    for (const file of files) transfer.items.add(file);
    target.section.dispatchEvent(new win.DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }

  async function includeImages(target: Target, images: string[], isActive: () => boolean) {
    if (!images.length) return;
    const count = () => target.section.querySelectorAll("#llm-image-preview-strip [data-image-context-index]").length;
    const expected = count() + images.length;
    const files = images.map((image, index) => {
      const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(image);
      if (!match) throw new Error("无法读取来源卡片的截图。");
      const bytes = Uint8Array.from(win.atob(match[2]), (character) => character.charCodeAt(0));
      return new win.File([bytes], `canvas-${index + 1}.${match[1].split("/")[1]}`, { type: match[1] });
    });
    attachFiles(target, files);
    const deadline = Date.now() + 6000;
    while (isActive() && count() < expected && Date.now() < deadline) await Zotero.Promise.delay(50);
    if (count() < expected) throw new Error("原版输入栏未能添加来源截图，请检查当前模型是否支持图像。");
  }

  function dismissSelectionPopup(chat: HTMLElement) {
    const promptInput = chat.querySelector<HTMLTextAreaElement>(".llm-assistant-selection-prompt-input");
    promptInput?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Escape", bubbles: false, cancelable: true }));
    chat.querySelector("#llm-chat-box")?.dispatchEvent(new win.Event("scroll"));
  }

  function removeAddedQuoteChips(target: Target, count: number) {
    for (let removed = 0; removed < count; removed++) {
      const chips = target.section.querySelectorAll<HTMLElement>("#llm-selected-context-list .llm-selected-context");
      const last = chips[chips.length - 1];
      const clear = last?.querySelector<HTMLButtonElement>(".llm-selected-context-clear");
      if (!clear) break;
      clear.click();
    }
  }

  async function includeQuotes(target: Target, quotes: string[]) {
    if (!quotes.length) return { ok: false, added: 0 };
    const chatBox = target.chat.querySelector<HTMLElement>("#llm-chat-box");
    const bubble = chatBox?.querySelector<HTMLElement>('[data-message-role="assistant"] .llm-bubble.assistant:not(.streaming)');
    const popup = target.chat.querySelector<HTMLElement>(".llm-assistant-selection-popup");
    const quoteButton = popup?.querySelector<HTMLButtonElement>(".llm-assistant-selection-action:not(.llm-assistant-selection-side-action)");
    if (!chatBox || !bubble || !popup || !quoteButton) return { ok: false, added: 0 };
    const chipCount = () => target.section.querySelectorAll("#llm-selected-context-list .llm-selected-context").length;
    if (chipCount() + quotes.length > 5) return { ok: false, added: 0 };
    let added = 0;
    for (const [index, snippet] of quotes.entries()) {
      dismissSelectionPopup(target.chat);
      const selection = win.getSelection();
      if (!selection) {
        removeAddedQuoteChips(target, added);
        return { ok: false, added: 0 };
      }
      const savedRanges: Range[] = [];
      for (let i = 0; i < selection.rangeCount; i++) savedRanges.push(selection.getRangeAt(i).cloneRange());
      const probe = html(doc, "span");
      probe.style.cssText = "position:fixed;left:-99999px;top:0;opacity:0;visibility:visible;pointer-events:none;white-space:pre-wrap;user-select:text;-moz-user-select:text;";
      probe.textContent = snippet;
      const needsProbe = chatBox.getClientRects().length === 0;
      let ok = false;
      try {
        if (needsProbe) target.chat.setAttribute("data-zcanvas-quote-probe", "");
        bubble.append(probe);
        const range = doc.createRange();
        range.selectNodeContents(probe);
        selection.removeAllRanges();
        selection.addRange(range);
        if (!selection.isCollapsed) {
          const before = chipCount();
          quoteButton.click();
          const after = chipCount();
          const expanded = popup.classList.contains("is-expanded");
          if (after > before) {
            added += after - before;
            ok = true;
          } else if (expanded) {
            ok = true;
          }
        }
      } finally {
        probe.remove();
        selection.removeAllRanges();
        for (const range of savedRanges) {
          try {
            if (range.startContainer.isConnected && range.endContainer.isConnected) selection.addRange(range);
          } catch { /* ignore stale range */ }
        }
        if (needsProbe) target.chat.removeAttribute("data-zcanvas-quote-probe");
        dismissSelectionPopup(target.chat);
      }
      if (!ok) {
        removeAddedQuoteChips(target, added);
        return { ok: false, added: 0 };
      }
      if (index + 1 < quotes.length) await Zotero.Promise.delay(20);
    }
    target.input.focus({ preventScroll: true });
    return { ok: true, added };
  }

  function removeAddedMarkdownFile(target: Target, fileName: string) {
    const rows = Array.from(target.section.querySelectorAll("#llm-file-context-list .llm-file-context-item")) as HTMLElement[];
    for (const row of rows) {
      if (row.querySelector(".llm-file-context-name")?.textContent?.trim() === fileName) {
        row.querySelector<HTMLButtonElement>(".llm-file-context-remove")?.click();
        return;
      }
    }
  }

  async function includeMarkdownFile(target: Target, markdown: string, isActive: () => boolean) {
    if (!markdown.trim()) return undefined;
    const names = Array.from(target.section.querySelectorAll("#llm-file-context-list .llm-file-context-name")) as Element[];
    const existingNames = new Set(names.map((node) => (node.textContent || "").trim().toLowerCase()));
    let fileName = "canvas-context.md";
    for (let suffix = 2; existingNames.has(fileName.toLowerCase()); suffix++) {
      fileName = `canvas-context-${suffix}.md`;
    }
    const count = () => target.section.querySelectorAll("#llm-file-context-list .llm-file-context-item").length;
    const expected = count() + 1;
    attachFiles(target, [new win.File([markdown], fileName, { type: "text/markdown" })]);
    const deadline = Date.now() + 6000;
    while (isActive() && count() < expected && Date.now() < deadline) await Zotero.Promise.delay(50);
    if (count() < expected) throw new Error("原版输入栏未能添加画布上下文附件，请重试。");
    return fileName;
  }

  function open(command: Open) {
    if (runtimeSwitch) throw new Error("请等运行时切换完成。");
    active?.close();
    const first = locate();
    if (!first) {
      throw new Error(conversationAt(container, itemID) ? "请先结束论文对话中的当前操作。" : "请先在 LLM for Zotero 中打开这篇文献的论文对话。");
    }
    const openingKey = first.key;
    let composerKey = openingKey;
    let parents = command.continueMain ? [] : command.parents;
    let restoreDraft: "switched" | "failed" | undefined;
    const css = html(doc, "style");
    css.textContent = styles;
    doc.documentElement.append(css);
    const head = html(doc, "div");
    head.className = "zcanvas-composer-head";
    const title = html(doc, "span");
    const label = parents.length > 1 ? "汇聚" : parents.length ? "追问" : command.source ? "继续对话" : "论文对话";
    title.textContent = command.source ? `${label} · ${command.source}` : label;
    title.title = title.textContent;
    const dismiss = html(doc, "button");
    dismiss.type = "button";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "关闭提问");
    dismiss.addEventListener("click", () => cleanup());
    head.append(title, dismiss);
    const quote = html(doc, "blockquote");
    quote.className = "zcanvas-composer-quote";
    quote.textContent = command.quote ?? "";
    const error = html(doc, "div");
    error.className = "zcanvas-composer-error";
    error.setAttribute("role", "alert");
    const suggestions = html(doc, "div");
    suggestions.className = "zcanvas-composer-suggestions";
    if (command.parents.length) {
      for (const [label, prompt] of questionSuggestions) {
        const button = html(doc, "button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => {
          if (!current || pending || runtimeSwitch) return;
          write(current.input, prompt);
          current.input.focus({ preventScroll: true });
        });
        suggestions.append(button);
      }
    }

    let current: Target | undefined;
    let draft = command.draft;
    let live = true;
    let pending = false;
    let forwarding = false;
    let originalDraft = "";
    let sendWatch = 0;
    let layoutFrame = 0;
    const resize = new win.ResizeObserver(schedule);
    const observe = new win.MutationObserver(schedule);

    function recordDraft() {
      if (!current || runtimeSwitch) return;
      draft = current.input.value.slice(0, 20000);
      suggestions.hidden = Boolean(draft.trim());
      error.textContent = "";
    }

    function detach() {
      if (!current) return;
      current.section.removeAttribute("data-zcanvas-composer");
      for (const key of ["left", "top", "width"]) current.section.style.removeProperty(`--zcanvas-${key}`);
      current.input.removeEventListener("input", recordDraft);
      current.section.removeEventListener("keydown", onKey, true);
      current.section.removeEventListener("click", onSend, true);
      current.chat.removeEventListener("click", onRuntimeClick, true);
      if (parents.length && current.input.isConnected && locate()?.key === current.key &&
          current.input.value !== originalDraft) write(current.input, originalDraft);
      for (const [selector] of menus) {
        const menu = current.chat.querySelector<HTMLElement>(selector);
        menu?.removeAttribute("data-zcanvas-menu");
        for (const key of ["left", "top", "width"]) menu?.style.removeProperty(`--zcanvas-${key}`);
      }
      resize.unobserve(current.section);
      current = undefined;
    }

    function cleanup(sent = false) {
      if (!live) return;
      live = false;
      if (current && conversationAt(container, itemID)?.key === current.key) {
        if (!sent && !pending) recordDraft();
      }
      win.cancelAnimationFrame(layoutFrame);
      win.clearInterval(sendWatch);
      doc.removeEventListener("keydown", escape);
      doc.removeEventListener("click", closeOnHistoryNavigation, true);
      doc.removeEventListener("keydown", closeOnHistoryNavigation, true);
      win.removeEventListener("resize", schedule);
      observe.disconnect();
      resize.disconnect();
      detach();
      head.remove();
      quote.remove();
      error.remove();
      suggestions.remove();
      css.remove();
      if (active?.request === command.request) active = undefined;
      closed(command.request, sent ? "" : draft);
    }

    function assign(target: Target, keepDraft = false) {
      current = target;
      current.section.setAttribute("data-zcanvas-composer", "");
      current.section.prepend(head);
      if (command.quote) head.after(quote);
      if (parents.length) current.section.append(suggestions);
      current.section.append(error);
      for (const [selector] of menus) current.chat.querySelector(selector)?.setAttribute("data-zcanvas-menu", "");
      current.input.addEventListener("input", recordDraft);
      current.section.addEventListener("keydown", onKey, true);
      current.section.addEventListener("click", onSend, true);
      current.chat.addEventListener("click", onRuntimeClick, true);
      originalDraft = current.input.value;
      if ((keepDraft || parents.length || !originalDraft) && originalDraft !== draft) write(current.input, draft);
      recordDraft();
      resize.observe(current.section);
      current.input.focus({ preventScroll: true });
    }

    function schedule() {
      if (!live || layoutFrame || runtimeSwitch) return;
      layoutFrame = win.requestAnimationFrame(() => {
        layoutFrame = 0;
        if (runtimeSwitch) return;
        const next = locate();
        if (!next || !iframe.isConnected) return;
        if (next.key !== composerKey) {
          cleanup();
          return;
        }
        if (next.input !== current?.input || next.section !== current.section || next.key !== current.key) {
          detach();
          assign(next, Boolean(restoreDraft));
        } else if (restoreDraft && next.input.value !== draft) {
          write(next.input, draft);
        }
        if (restoreDraft === "failed") error.textContent = "无法切换运行时，请重试。";
        restoreDraft = undefined;
        const frame = iframe.getBoundingClientRect();
        const width = Math.min(370, frame.width - 16);
        if (width <= 0) return;
        const inset = 8;
        const left = Math.min(Math.max(command.anchor?.left ?? inset, inset), frame.width - width - inset);
        const height = next.section.getBoundingClientRect().height;
        const bottom = command.anchor?.bottom ?? frame.height - height - 2 * inset;
        const above = (command.anchor?.top ?? frame.height) - height - 6;
        const limit = frame.height - height - inset;
        const top = Math.max(inset, Math.min(bottom + 6 <= limit ? bottom + 6 : above, limit));
        position(next.section, frame.left + left, frame.top + top, width);
        for (const [menuSelector, anchorSelector] of menus) {
          const menu = next.chat.querySelector<HTMLElement>(menuSelector);
          const anchor = next.chat.querySelector(anchorSelector);
          if (!menu || !anchor || !menu.getClientRects().length) continue;
          const bounds = menu.getBoundingClientRect();
          const trigger = anchor.getBoundingClientRect();
          const x = Math.min(Math.max(trigger.left, frame.left + inset), frame.right - Math.min(bounds.width, width) - inset);
          const y = trigger.top - bounds.height - 5;
          position(menu, x, y >= inset ? y : Math.max(inset, Math.min(trigger.bottom + 5, win.innerHeight - bounds.height - inset)), width);
        }
      });
    }

    function onRuntimeClick(event: Event) {
      const row = (event.target as Element | null)?.closest?.<HTMLElement>("#llm-runtime-menu button[data-runtime-system]");
      const system = row?.dataset.runtimeSystem;
      if (!system || row.getAttribute("aria-checked") !== "false" || !current ||
          conversationAt(container, itemID)?.key !== current.key) return;
      if (pending || runtimeSwitch) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      recordDraft();
      const resume = (key?: number) => {
        if (!live) return;
        if (key !== undefined) {
          composerKey = key;
          parents = command.continueMain && key === openingKey ? [] : command.parents;
        }
        restoreDraft = key === undefined ? "failed" : "switched";
        schedule();
      };
      runtimeSwitch = {
        from: current.key, system, resume,
        timer: win.setTimeout(() => {
          clearRuntimeSwitch();
          resume();
        }, 8000),
      };
      // The native switch saves the outgoing input as that conversation's draft.
      if (parents.length && current.input.value !== originalDraft) write(current.input, originalDraft);
    }

    function watchSend(target: Target) {
      let attempts = 0;
      win.clearInterval(sendWatch);
      sendWatch = win.setInterval(() => {
        if (!target.input.value || target.chat.querySelector(".llm-bubble.streaming, .llm-typing, .llm-rose-loader")) cleanup(true);
        else if (++attempts >= 40) win.clearInterval(sendWatch);
      }, 75);
    }

    function onSend(event: Event) {
      const target = current;
      if (!target || forwarding || !target.send.contains(event.target as Node)) return;
      if (runtimeSwitch) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      if (conversationAt(container, itemID)?.key !== target.key) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cleanup();
        return;
      }
      const text = target.input.value.trim();
      const nativeCommand = text.startsWith("/") || target.section.querySelector("#llm-command-row[data-active]");
      if (!parents.length || nativeCommand) {
        watchSend(target);
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pending) return;
      if (!text) {
        error.textContent = "输入要追问的问题后再发送。";
        return;
      }
      pending = true;
      const isActive = () => live && current === target;
      void session.submitNativeBranch(parents, text.slice(0, 20000), command.quote, target.key, async (payload) => {
        let addedQuotes = 0;
        let addedFile: string | undefined;
        const rollback = () => {
          if (addedQuotes) removeAddedQuoteChips(target, addedQuotes);
          if (addedFile) removeAddedMarkdownFile(target, addedFile);
        };
        try {
          await includeImages(target, payload.images, isActive);
          const quoted = await includeQuotes(target, payload.quotes);
          addedQuotes = quoted.added;
          if (!quoted.ok && payload.markdown.trim()) {
            addedFile = await includeMarkdownFile(target, payload.markdown, isActive);
          }
          if (!live || current !== target || locate()?.key !== target.key ||
              target.input.value.trim() !== text || target.send.disabled || !target.send.getClientRects().length) {
            throw new Error("提问框或对话已切换，请重新发送。");
          }
          const previousMax = Math.max(-1, ...userIndices(target.chat));
          const sentValue = target.input.value;
          forwarding = true;
          try { target.send.click(); } finally { forwarding = false; }
          const deadline = Date.now() + 6000;
          while (live && target.input.value === sentValue && Date.now() < deadline) await Zotero.Promise.delay(50);
          if (target.input.value === sentValue) {
            throw new Error("原版输入栏未接受这次提问，请检查当前运行时后重试。");
          }
          let messageIndex: number | undefined;
          const indexDeadline = Date.now() + 250;
          while (Date.now() < indexDeadline) {
            const next = userIndices(target.chat).findLast((index) => index > previousMax);
            if (next !== undefined) {
              messageIndex = next;
              break;
            }
            await Zotero.Promise.delay(25);
          }
          if (!live) throw new Error("提问框已关闭。");
          cleanup(true);
          return { messageIndex };
        } catch (cause) {
          rollback();
          throw cause;
        }
      }, () => target.chat.querySelector<HTMLButtonElement>("#llm-cancel")?.click())
        .catch((cause) => { error.textContent = errorMessage(cause); })
        .finally(() => { pending = false; });
    }

    function onKey(event: KeyboardEvent) {
      if (!current || event.target !== current.input || event.key !== "Enter" ||
          event.shiftKey || event.repeat || event.isComposing) return;
      if (current.chat.querySelector('.llm-slash-menu-open, .llm-paper-picker[style*="display: block"], .llm-action-picker[style*="display: block"]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      current.send.click();
    }

    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing &&
          (current?.section.contains(event.target as Node) || doc.activeElement === iframe)) cleanup();
    }

    function closeOnHistoryNavigation(event: Event) {
      if (event.type === "keydown" && !["Enter", " "].includes((event as KeyboardEvent).key)) return;
      if ((event.target as Element | null)?.closest?.(historyNavigation)) {
        cleanup();
        clearRuntimeSwitch();
      }
    }

    active = { request: command.request, close: cleanup };
    assign(first);
    resize.observe(iframe);
    observe.observe(doc.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ["style", "class", "data-item-id", "data-conversation-system"],
    });
    win.addEventListener("resize", schedule);
    doc.addEventListener("keydown", escape);
    doc.addEventListener("click", closeOnHistoryNavigation, true);
    doc.addEventListener("keydown", closeOnHistoryNavigation, true);
    schedule();
  }

  async function summarize(
    conversationKey: number,
    payload: NativeBranchSubmission,
    onSent: (info: { messageIndex?: number }) => void,
  ): Promise<string> {
    active?.close();
    const target = locate();
    if (!target || (conversationKey && target.key !== conversationKey)) {
      throw new Error("请先在 LLM for Zotero 中打开这篇文献的论文对话。");
    }
    if (target.input.value.trim()) throw new Error("论文对话中有未发送的草稿，请先处理草稿。");
    if (target.chat.querySelector(".llm-bubble.streaming, .llm-typing, .llm-rose-loader")) {
      throw new Error("请等论文对话中的当前回答生成完毕。");
    }
    const isActive = () => iframe.isConnected && conversationAt(container, itemID)?.key === target.key;
    let addedQuotes = 0;
    let addedFile: string | undefined;
    let wrotePrompt = false;
    const rollback = () => {
      if (addedQuotes) removeAddedQuoteChips(target, addedQuotes);
      if (addedFile) removeAddedMarkdownFile(target, addedFile);
      if (wrotePrompt && target.input.value === payload.prompt) write(target.input, "");
    };
    let previousMax = -1;
    let messageIndex: number | undefined;
    try {
      await includeImages(target, payload.images, isActive);
      const quoted = await includeQuotes(target, payload.quotes);
      addedQuotes = quoted.added;
      if (!quoted.ok && payload.markdown.trim()) {
        addedFile = await includeMarkdownFile(target, payload.markdown, isActive);
      }
      if (!isActive() || locate()?.section !== target.section) {
        throw new Error("论文对话已切换，请重试。");
      }
      write(target.input, payload.prompt);
      wrotePrompt = true;
      if (target.send.disabled || target.send.hidden) {
        throw new Error("论文对话现在无法发送，请检查 LLM for Zotero 的输入栏。");
      }
      previousMax = Math.max(-1, ...userIndices(target.chat));
      target.send.click();
      const sendDeadline = Date.now() + 6000;
      while (isActive() && target.input.value === payload.prompt && Date.now() < sendDeadline) {
        await Zotero.Promise.delay(50);
      }
      if (target.input.value === payload.prompt) {
        throw new Error("原版输入栏未接受这次请求，请检查当前运行时后重试。");
      }
      addedQuotes = 0;
      addedFile = undefined;
      wrotePrompt = false;
      const indexDeadline = Date.now() + 500;
      while (isActive() && Date.now() < indexDeadline) {
        const next = userIndices(target.chat).findLast((index) => index > previousMax);
        if (next !== undefined) {
          messageIndex = next;
          break;
        }
        await Zotero.Promise.delay(25);
      }
      onSent({ messageIndex });
    } catch (cause) {
      rollback();
      throw cause;
    }

    const pollDeadline = Date.now() + 180_000;
    while (isActive() && Date.now() < pollDeadline) {
      const outcome = readTurnOutcome(target.chat, previousMax, messageIndex);
      if (outcome.state === "done") {
        await Zotero.Promise.delay(80);
        if (!iframe.isConnected) throw new Error("画布已关闭。");
        if (conversationAt(container, itemID)?.key !== target.key) throw new Error("当前论文对话已切换。");
        const settled = readTurnOutcome(target.chat, previousMax, messageIndex);
        if (settled.state === "done") {
          if (settled.stopped) throw new Error("笔记生成已停止。");
          return settled.answer;
        }
      }
      await Zotero.Promise.delay(120);
    }
    if (!iframe.isConnected) throw new Error("画布已关闭。");
    if (conversationAt(container, itemID)?.key !== target.key) throw new Error("当前论文对话已切换。");
    throw new Error("生成笔记超时，请在论文对话中查看结果。");
  }

  return {
    open,
    summarize,
    canSync,
    dispose() { active?.close(); clearRuntimeSwitch(); },
    close(request?: string) { if (!request || active?.request === request) active?.close(); },
  };
}
