import type { CitedAnswer, Command, Event } from "../shared/schema";
import { answerForTurn, answerMarkdown, conversationAt } from "./llm-turn";

type OpenCitation = Extract<Command, { type: "openAnswerCitation" }>;
type CitationClosed = Extract<Event, { type: "citationClosed" }>;
const nativePopover = ".llm-paper-source-popover.llm-web-source-popover-visible";

export function nativeCitations(container: Element, iframe: HTMLIFrameElement, itemID: number,
  closed: (event: CitationClosed) => void) {
  const doc = container.ownerDocument;
  const win = doc.defaultView as Window & typeof globalThis;
  let preview: { prefix: string; turnID: string; chips: HTMLButtonElement[] } | undefined;
  let opened: { close(restoreFocus?: boolean, notify?: boolean): void } | undefined;

  function read(turnID: string): CitedAnswer | null {
    opened?.close(false, false);
    preview = undefined;
    const blocks = answerForTurn(container, itemID, turnID);
    const chips: HTMLButtonElement[] = [];
    const prefix = `#canvas-citation-${win.crypto.randomUUID()}-`;
    const answer = answerMarkdown(blocks, (mark) => {
      const chip = mark.querySelector<HTMLButtonElement>("button.llm-web-source-chip");
      const label = mark.querySelector(".llm-paper-source-count")?.textContent?.trim();
      if (!chip || !label || !/^\d+(?:,\s*\d+)*$/.test(label)) return "";
      const index = chips.push(chip) - 1;
      return ` [${label}](${prefix}${index})`;
    });
    if (!chips.length) return null;
    preview = { prefix, turnID, chips };
    return { answer, prefix, count: chips.length };
  }

  function open({ prefix, index, anchor }: OpenCitation) {
    const current = conversationAt(container, itemID);
    const trigger = preview?.chips[index];
    if (!current || !preview || preview.prefix !== prefix || !preview.turnID.startsWith(`${current.key}:`) ||
        !trigger?.isConnected || !current.chat.contains(trigger) || !iframe.getClientRects().length) {
      throw new Error("引用已更新。请重新展开卡片。");
    }
    const chip = trigger;
    opened?.close(false, false);
    if (chip.getAttribute("aria-expanded") === "true") chip.click();
    const existing = new Set(doc.querySelectorAll(nativePopover));
    chip.click();
    const popup = ([...doc.querySelectorAll(nativePopover)] as HTMLElement[]).find((node) => !existing.has(node));
    if (!popup?.parentNode) {
      if (chip.getAttribute("aria-expanded") === "true") chip.click();
      throw new Error("无法打开这处引用。");
    }
    const popover = popup;
    const messages = chip.closest(".llm-messages");

    function close(restoreFocus = false, notify = true) {
      opened = undefined;
      observer.disconnect();
      resize.disconnect();
      doc.removeEventListener("keydown", escape, true);
      win.removeEventListener("resize", reposition);
      messages?.removeEventListener("scroll", reposition);
      if (chip.getAttribute("aria-expanded") === "true") chip.click();
      if (notify) closed({ type: "citationClosed", prefix, index, restoreFocus });
    }

    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !popover.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    }

    const reposition = () => {
      const frame = iframe.getBoundingClientRect();
      const left = Math.max(0, frame.left) + 8;
      const right = Math.min(win.innerWidth, frame.right) - 8;
      const top = Math.max(0, frame.top) + 8;
      const bottom = Math.min(win.innerHeight, frame.bottom) - 8;
      const width = Math.min(360, right - left);
      const above = frame.top + anchor.top - top - 8;
      const below = bottom - frame.top - anchor.bottom - 8;
      if (width <= 0 || Math.max(above, below) <= 0) return close();
      popover.style.width = `${width}px`;
      const alignAbove = above >= popover.scrollHeight || above >= below;
      popover.classList.toggle("llm-web-source-popover-below", !alignAbove);
      const heightLimit = alignAbove ? above : below;
      popover.style.maxHeight = `${heightLimit}px`;
      popover.style.left = `${Math.max(left, Math.min(frame.left + anchor.right - width, right - width))}px`;
      popover.style.top = `${alignAbove
        ? frame.top + anchor.top - 8 - popover.getBoundingClientRect().height
        : frame.top + anchor.bottom + 8}px`;
    };
    const observer = new win.MutationObserver(() => {
      if (!popover.isConnected) close();
    });
    const resize = new win.ResizeObserver(reposition);
    opened = { close };
    observer.observe(popup.parentNode, { childList: true });
    resize.observe(iframe);
    doc.addEventListener("keydown", escape, true);
    win.addEventListener("resize", reposition);
    messages?.addEventListener("scroll", reposition, { passive: true });
    reposition();
    if (popover.isConnected) {
      popover.tabIndex = -1;
      popover.focus({ preventScroll: true });
    }
  }

  return {
    read,
    open,
    dismiss(prefix?: string) {
      if (prefix === undefined || preview?.prefix === prefix) opened?.close(false, prefix === undefined);
    },
    reset() {
      opened?.close();
      preview = undefined;
    },
  };
}
