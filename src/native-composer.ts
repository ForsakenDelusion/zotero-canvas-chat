import { errorMessage, type Command } from "../shared/schema";
import { questionSuggestions } from "../shared/question";
import { conversationAt } from "./llm-turn";
import type { CanvasSession } from "./session";

type Open = Extract<Command, { type: "openComposer" }>;
type HostWindow = Window & typeof globalThis;
const namespace = "http://www.w3.org/1999/xhtml";
const menus = [
  ["#llm-runtime-menu", "#llm-runtime-mode-toggle"],
  ["#llm-model-menu", "#llm-model-toggle"],
  ["#llm-reasoning-menu", "#llm-reasoning-toggle"],
  ["#llm-slash-menu", "#llm-upload-file"],
] as const;
const historyNavigation = ".llm-standalone-sidebar .llm-standalone-conv-item, .llm-standalone-nav-new-chat, .llm-standalone-search-item";

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
  closed: (request: string, draft: string) => void) {
  const doc = container.ownerDocument;
  const win = doc.defaultView as HostWindow;
  let active: { close(): void; request: string } | undefined;

  function open(command: Open) {
    active?.close();
    const locate = () => {
      const current = conversationAt(container, itemID);
      const section = current?.chat.querySelector<HTMLElement>(":scope > .llm-input-section");
      const input = section?.querySelector<HTMLTextAreaElement>("#llm-input");
      const send = section?.querySelector<HTMLButtonElement>("#llm-send");
      return current && section && input && send && !input.disabled && !input.readOnly
        ? { ...current, section, input, send } : undefined;
    };
    const first = locate();
    if (!first) return false;
    const css = html(doc, "style");
    css.textContent = styles;
    doc.documentElement.append(css);
    const head = html(doc, "div");
    head.className = "zcanvas-composer-head";
    const title = html(doc, "span");
    const label = command.parents.length > 1 ? "汇聚" : command.parents.length ? "追问" : "论文对话";
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
          if (!current || pending) return;
          write(current.input, prompt);
          current.input.focus({ preventScroll: true });
        });
        suggestions.append(button);
      }
    }

    let current: ReturnType<typeof locate>;
    let draft = command.draft;
    let live = true;
    let pending = false;
    let forwarding = false;
    let forwardedText = "";
    let originalDraft = "";
    let sendWatch = 0;
    let layoutFrame = 0;
    const resize = new win.ResizeObserver(schedule);
    const observe = new win.MutationObserver(schedule);

    function write(input: HTMLTextAreaElement, text: string) {
      input.value = text;
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    }

    function recordDraft() {
      if (!current) return;
      if (!forwardedText || current.input.value !== forwardedText) draft = current.input.value.slice(0, 20000);
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
      if (command.parents.length && current.input.isConnected && locate()?.key === current.key &&
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
        if (forwardedText && current.input.value === forwardedText) write(current.input, draft);
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

    function assign(target: NonNullable<ReturnType<typeof locate>>) {
      current = target;
      current.section.setAttribute("data-zcanvas-composer", "");
      current.section.prepend(head);
      if (command.quote) head.after(quote);
      if (command.parents.length) current.section.append(suggestions);
      current.section.append(error);
      for (const [selector] of menus) current.chat.querySelector(selector)?.setAttribute("data-zcanvas-menu", "");
      current.input.addEventListener("input", recordDraft);
      current.section.addEventListener("keydown", onKey, true);
      current.section.addEventListener("click", onSend, true);
      originalDraft = current.input.value;
      if ((command.parents.length || !originalDraft) && originalDraft !== draft) write(current.input, draft);
      recordDraft();
      resize.observe(current.section);
      current.input.focus({ preventScroll: true });
    }

    function schedule() {
      if (!live || layoutFrame) return;
      layoutFrame = win.requestAnimationFrame(() => {
        layoutFrame = 0;
        const next = locate();
        if (!next || !iframe.isConnected) return;
        if (next.section !== current?.section || next.key !== current.key) {
          detach();
          assign(next);
        }
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

    function watchSend(target: NonNullable<ReturnType<typeof locate>>) {
      let attempts = 0;
      win.clearInterval(sendWatch);
      sendWatch = win.setInterval(() => {
        if (!target.input.value || target.chat.querySelector(".llm-bubble.streaming")) cleanup(true);
        else if (++attempts >= 40) win.clearInterval(sendWatch);
      }, 75);
    }

    async function includeImages(target: NonNullable<ReturnType<typeof locate>>, images: string[]) {
      if (!images.length) return;
      const count = () => target.section.querySelectorAll("#llm-image-preview-strip [data-image-context-index]").length;
      const expected = count() + images.length;
      const files = new win.DataTransfer();
      for (const [index, image] of images.entries()) {
        const match = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/.exec(image);
        if (!match) throw new Error("无法读取来源卡片的截图。");
        const bytes = Uint8Array.from(win.atob(match[2]), (character) => character.charCodeAt(0));
        files.items.add(new win.File([bytes], `canvas-${index + 1}.${match[1].split("/")[1]}`, { type: match[1] }));
      }
      target.input.dispatchEvent(new win.ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: files }));
      const deadline = Date.now() + 6000;
      while (live && current === target && count() < expected && Date.now() < deadline) await Zotero.Promise.delay(50);
      if (count() < expected) throw new Error("原版输入栏未能添加来源截图，请检查当前模型是否支持图像。");
    }

    function onSend(event: Event) {
      const target = current;
      if (!target || forwarding || !target.send.contains(event.target as Node)) return;
      if (conversationAt(container, itemID)?.key !== target.key) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cleanup();
        return;
      }
      const text = target.input.value.trim();
      const nativeCommand = text.startsWith("/") || target.section.querySelector("#llm-command-row[data-active]");
      if (!command.parents.length || nativeCommand) {
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
      void session.submitNativeBranch(command.parents, text.slice(0, 20000), command.quote, target.key, async (message, images) => {
        await includeImages(target, images);
        if (!live || current !== target || locate()?.key !== target.key ||
            target.input.value.trim() !== text || target.send.disabled || !target.send.getClientRects().length) {
          throw new Error("提问框或对话已切换，请重新发送。");
        }
        forwardedText = message;
        target.input.value = message;
        forwarding = true;
        try { target.send.click(); } finally { forwarding = false; }
        const deadline = Date.now() + 6000;
        while (live && target.input.value === message && Date.now() < deadline) await Zotero.Promise.delay(50);
        if (target.input.value === message) {
          write(target.input, draft);
          forwardedText = "";
          throw new Error("原版输入栏未接受这次提问，请检查当前运行时后重试。");
        }
        if (!live) throw new Error("提问框已关闭。");
        cleanup(true);
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
      if ((event.target as Element | null)?.closest?.(historyNavigation)) cleanup();
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
    return true;
  }

  return {
    open,
    close(request?: string) { if (!request || active?.request === request) active?.close(); },
  };
}
