import { errorMessage } from "../shared/schema";
import { readNativePrompt } from "../shared/question";
import { companionGlobals } from "./companion";
import { parentPaper } from "./library";

type Receiver = NonNullable<ReturnType<typeof companionGlobals>["ZoteroCanvasChat"]>;
type HostWindow = Window & typeof globalThis;
const chatURL = "chrome://llmforzotero/content/standaloneChat.xhtml";
const rightPanel = "#llm-standalone-side-panel";
const panelView = ".llm-standalone-side-panel-view";
const nativeTab = ".llm-standalone-side-panel-tab";
const plus = ".llm-standalone-side-panel-icon-new-tab";
const paperChat = "#llm-main[data-conversation-kind='paper']";
const chatBody = `.llm-standalone-content ${paperChat}`;
const readerChat = `#zotero-context-pane-item-deck ${paperChat}, item-details[tabType="reader"] ${paperChat}`;
const sidebarToggle = ".llm-standalone-side-panel-toggle";
const legacyTransferButton = ".llm-message-actions .llm-message-action-canvas";
const branchContext = ".zcanvas-branch-context";
const html = "http://www.w3.org/1999/xhtml";

function element(doc: Document, name: "button", text: string): HTMLButtonElement;
function element(doc: Document, name: "div" | "span" | "style", text?: string): HTMLElement;
function element(doc: Document, name: string, text = "") {
  const node = doc.createElementNS(html, name);
  node.textContent = text;
  return node;
}

function paperIDFor(chat: HTMLElement | null) {
  const id = Number(chat?.dataset.basePaperItemId || chat?.dataset.itemId || 0);
  return id > 0 ? parentPaper(Zotero.Items.get(id))?.id ?? 0 : 0;
}

function removeLegacyTransferButtons(doc: Document) {
  doc.querySelectorAll(legacyTransferButton).forEach((button) => button.remove());
}

function compactBranchBubbles(doc: Document) {
  doc.querySelectorAll(`${paperChat} .llm-bubble.user`).forEach((bubble) => {
    const node = bubble.firstChild;
    if (bubble.childNodes.length !== 1 || node?.nodeType !== 3) return;
    const text = node as Text;
    const { contextOffset } = readNativePrompt(text.data);
    if (contextOffset === undefined) return;
    const material = element(doc, "span");
    material.className = branchContext.slice(1);
    material.style.display = "none";
    material.textContent = text.data.slice(contextOffset);
    text.deleteData(contextOffset, text.length - contextOffset);
    bubble.append(material);
  });
}

function restoreBranchBubbles(doc: Document) {
  doc.querySelectorAll(branchContext).forEach((material) => {
    const bubble = material.parentNode;
    material.replaceWith(material.textContent ?? "");
    bubble?.normalize();
  });
}

function attachReader(win: HostWindow, receiver: Receiver) {
  const doc = win.document;
  const zh = Zotero.locale.startsWith("zh");
  const css = element(doc, "style", `
    #llm-main .llm-header-actions > .zcanvas-reader-button {
      flex: none; width: auto; min-width: 0; color: var(--fill-primary); opacity: 1; height: 24px; padding-inline: 6px;
      background: var(--fill-quinary); border-radius: 6px; white-space: nowrap;
      font: inherit; font-weight: 600; font-size: var(--llm-fs-11, 11px);
    }
    #llm-main .llm-header-actions > .zcanvas-reader-button:hover,
    #llm-main .llm-header-actions > .zcanvas-reader-button[aria-pressed="true"] { background: var(--fill-quaternary); }
    #llm-main[data-zcanvas-reader-active] > :not(.llm-header, .zcanvas-reader-content, [data-zcanvas-composer], [data-zcanvas-menu]) { display: none !important; }
    .zcanvas-reader-content { position: relative; flex: 1; min-height: 0; min-width: 0; }
    .zcanvas-reader-content > iframe { position: absolute; inset: 0; }
    :root:not([data-llm-pane-view="chat"]) .zcanvas-reader-content {
      flex: none; height: max(var(--zcanvas-reader-height, 0px), min(360px, 55vh));
    }
  `);
  doc.documentElement.append(css);
  const mounted = new Map<HTMLElement, { id: number; button: HTMLButtonElement; dispose(): void }>();
  let frame = 0;

  function sync() {
    frame = 0;
    removeLegacyTransferButtons(doc);
    compactBranchBubbles(doc);
    for (const [chat, entry] of mounted) {
      if (chat.isConnected && entry.button.isConnected && chat.matches(readerChat) && paperIDFor(chat) === entry.id) continue;
      entry.dispose();
      mounted.delete(chat);
    }
    doc.querySelectorAll<HTMLElement>(readerChat).forEach((chat) => {
      if (mounted.has(chat)) return;
      const id = paperIDFor(chat);
      const actions = chat.querySelector(".llm-header-actions");
      if (!actions || !id) return;
      const button = element(doc, "button", zh ? "画布" : "Canvas");
      button.type = "button";
      button.className = "llm-btn-icon zcanvas-reader-button";
      button.setAttribute("aria-pressed", "false");
      button.title = zh ? "在此侧栏打开画布" : "Open canvas in this sidebar";
      const content = element(doc, "div");
      content.className = "zcanvas-reader-content";
      let unmount: (() => void) | undefined;
      function close() {
        unmount?.();
        unmount = undefined;
        chat.removeAttribute("data-zcanvas-reader-active");
        content.remove();
        button.setAttribute("aria-pressed", "false");
        button.title = zh ? "在此侧栏打开画布" : "Open canvas in this sidebar";
      }
      button.addEventListener("click", () => {
        if (unmount) return close();
        if (paperIDFor(chat) !== id) return;
        try {
          const headerHeight = actions.closest(".llm-header")?.getBoundingClientRect().height ?? 0;
          const height = Math.max(0, chat.getBoundingClientRect().height - headerHeight - 14);
          content.style.setProperty("--zcanvas-reader-height", `${height}px`);
          chat.append(content);
          unmount = receiver.mountPaper(id, content, close);
          chat.setAttribute("data-zcanvas-reader-active", "");
          button.setAttribute("aria-pressed", "true");
          button.title = zh ? "返回论文对话" : "Back to paper chat";
        } catch (error) {
          close();
          win.alert(errorMessage(error));
        }
      });
      actions.prepend(button);
      mounted.set(chat, { id, button, dispose() { close(); button.remove(); } });
    });
  }
  const observer = new win.MutationObserver(() => { if (!frame) frame = win.requestAnimationFrame(sync); });
  observer.observe(doc.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["data-conversation-kind", "data-base-paper-item-id", "data-item-id"],
  });
  sync();
  return {
    dispose() {
      observer.disconnect();
      win.cancelAnimationFrame(frame);
      for (const entry of mounted.values()) entry.dispose();
      restoreBranchBubbles(doc);
      css.remove();
    },
  };
}

function attach(win: HostWindow, receiver: Receiver) {
  const doc = win.document;
  const zh = Zotero.locale.startsWith("zh");
  const canvasLabel = zh ? "画布" : "Canvas";
  const css = element(doc, "style", `
    ${rightPanel}[data-zcanvas-active] ${panelView} > :not(.zcanvas-content) { display: none !important; }
    ${rightPanel}[data-zcanvas-active] ${panelView} { padding-top: 0; }
    ${rightPanel}[data-zcanvas-active] ${nativeTab}.active:not(.zcanvas-tab) { background: transparent; color: var(--fill-secondary); }
    ${rightPanel}[data-zcanvas-active] ${nativeTab}.active:not(.zcanvas-tab)::before,
    ${rightPanel}[data-zcanvas-active] ${nativeTab}.active:not(.zcanvas-tab)::after { display: none; }
    .llm-standalone-side-panel-tabs > :is(.zcanvas-tab, [data-side-tab-kind="canvas"]) {
      flex: 0 0 auto; min-width: 0; gap: 6px; padding-inline: 9px 5px;
    }
    .zcanvas-tab-open {
      display: inline-flex; align-items: center; gap: 6px; padding: 0; border: 0;
      background: transparent; color: inherit; font: inherit; cursor: pointer;
    }
    :is(.zcanvas-tab, [data-side-tab-kind="canvas"]) > .llm-standalone-side-panel-tab-close {
      margin-inline-start: 5px;
    }
    .zcanvas-nav[aria-pressed="true"], .zcanvas-top[aria-pressed="true"] {
      background: var(--fill-quinary); color: var(--fill-primary);
    }
    .zcanvas-icon {
      display: inline-block; flex: none; width: 13px; height: 13px; box-sizing: border-box;
      border: 1.5px solid currentColor; border-radius: 3px;
      background: linear-gradient(currentColor, currentColor) 42% / 1px 100% no-repeat,
        linear-gradient(currentColor, currentColor) 100% 55% / 60% 1px no-repeat;
    }
    .llm-standalone-title-action.zcanvas-top {
      width: auto; min-width: 0; gap: 5px; padding-inline: 7px; white-space: nowrap;
      -moz-window-dragging: no-drag;
      font-size: var(--llm-standalone-ui-font-size, 12px); font-weight: 600;
    }
    .llm-standalone-title-action.zcanvas-top::before { content: none !important; }
    .zcanvas-top[hidden] { display: none !important; }
  `);
  (doc.head ?? doc.documentElement).append(css);
  const navButton = element(doc, "button", "");
  navButton.type = "button";
  navButton.className = "llm-standalone-nav-row zcanvas-nav";
  navButton.title = canvasLabel;
  navButton.setAttribute("aria-controls", "llm-standalone-side-panel");
  const navIcon = element(doc, "span");
  navIcon.className = "zcanvas-icon";
  navIcon.setAttribute("aria-hidden", "true");
  const navLabel = element(doc, "span", canvasLabel);
  navLabel.className = "llm-standalone-nav-label";
  navButton.append(navIcon, navLabel);
  const topButton = element(doc, "button", canvasLabel);
  const topIcon = navIcon.cloneNode() as HTMLElement;
  topButton.prepend(topIcon);
  topButton.type = "button";
  topButton.className = "llm-standalone-title-action zcanvas-top";
  topButton.setAttribute("aria-controls", "llm-standalone-side-panel");
  const tab = element(doc, "div");
  tab.className = "llm-standalone-side-panel-tab zcanvas-tab";
  const select = element(doc, "button", canvasLabel);
  select.prepend(navIcon.cloneNode());
  select.type = "button";
  select.className = "zcanvas-tab-open";
  const close = element(doc, "button", "");
  close.type = "button";
  close.title = zh ? "关闭画布" : "Close canvas";
  close.setAttribute("aria-label", close.title);
  close.className = "llm-standalone-side-panel-tab-close";
  tab.append(select, close);
  const launch = element(doc, "button", canvasLabel);
  launch.type = "button";
  launch.className = "llm-standalone-nav-row llm-standalone-side-panel-launch-row zcanvas-launch";
  launch.dataset.sideLaunch = "canvas";
  const content = element(doc, "div");
  content.className = "zcanvas-content";
  content.dataset.sideView = "canvas";
  content.hidden = true;
  let panel: HTMLElement | null = null;
  let currentPaperID = 0;
  let canvasPaperID = 0;
  let unmount: (() => void) | undefined;
  let nativeSelection = "";
  let frame = 0;

  function paperID() {
    return paperIDFor(doc.querySelector<HTMLElement>(chatBody));
  }

  function markEntry(active: boolean) {
    navButton.setAttribute("aria-pressed", String(active));
    topButton.setAttribute("aria-pressed", String(active));
  }

  function show(active: boolean) {
    panel?.toggleAttribute("data-zcanvas-active", active);
    tab.classList.toggle("active", active);
    select.setAttribute("aria-pressed", String(active));
    content.hidden = !active;
    markEntry(active);
  }

  function closeCanvas() {
    show(false);
    unmount?.();
    unmount = undefined;
    canvasPaperID = 0;
    content.remove();
    tab.remove();
  }

  function selectedNativeTab() {
    const active = panel?.querySelector<HTMLElement>(`${nativeTab}[aria-selected="true"]`);
    return `${active?.dataset.sideTabId || active?.dataset.sideTabKind || ""}:${panel?.dataset.sideView || ""}`;
  }

  function open(itemID: number) {
    const nextPanel = doc.querySelector<HTMLElement>(rightPanel);
    const strip = nextPanel?.querySelector(".llm-standalone-side-panel-tabs");
    const view = nextPanel?.querySelector(panelView);
    const toggle = doc.querySelector<HTMLButtonElement>(sidebarToggle);
    if (!nextPanel || !strip || !view || !toggle) return false;
    if (panel !== nextPanel || canvasPaperID !== itemID) closeCanvas();
    panel = nextPanel;
    currentPaperID = paperID();
    if (panel.hidden) toggle.click();
    if (panel.hidden) return false;
    if (!unmount) {
      view.append(content);
      try {
        unmount = receiver.mountPaper(itemID, content, closeCanvas);
      } catch (error) {
        content.remove();
        throw error;
      }
      canvasPaperID = itemID;
    }
    if (tab.parentElement !== strip) strip.append(tab);
    nativeSelection = selectedNativeTab();
    show(true);
    return true;
  }

  function sync() {
    frame = 0;
    removeLegacyTransferButtons(doc);
    compactBranchBubbles(doc);
    const nextPanel = doc.querySelector<HTMLElement>(rightPanel);
    const nextPaperID = paperID();
    const navigation = doc.querySelector(".llm-standalone-primary-nav");
    const toggle = doc.querySelector(sidebarToggle);
    if (nextPaperID && nextPanel && navigation && toggle) {
      if (navButton.parentElement !== navigation) navigation.append(navButton);
      if (topButton.nextElementSibling !== toggle) toggle.before(topButton);
      topButton.hidden = navigation.closest(".llm-standalone-sidebar")?.getAttribute("data-sidebar-state") !== "collapsed";
    } else {
      navButton.remove();
      topButton.remove();
    }
    if (companionGlobals().LLMForZotero?.api?.canvas?.openPaper) {
      if (unmount) closeCanvas();
      panel = nextPanel;
      markEntry(!!panel && !panel.hidden && panel.dataset.sideView === "canvas");
      return;
    }
    if (!nextPanel || nextPanel !== panel || nextPaperID !== currentPaperID || panel?.hidden ||
        (unmount && (!content.isConnected || !tab.isConnected))) closeCanvas();
    panel = nextPanel;
    currentPaperID = nextPaperID;
    const nextSelection = selectedNativeTab();
    if (unmount && nativeSelection !== nextSelection) show(false);
    nativeSelection = nextSelection;
    const nav = panel?.querySelector(".llm-standalone-side-panel-newtab-nav");
    if (nav && currentPaperID) {
      if (launch.parentElement !== nav) nav.prepend(launch);
    } else launch.remove();
  }

  async function activate(itemID: number) {
    try {
      const nativeOpen = companionGlobals().LLMForZotero?.api?.canvas?.openPaper;
      if (itemID && nativeOpen) return await nativeOpen(itemID);
      if (itemID && open(itemID)) return;
      win.alert("当前 LLM for Zotero 窗口无法打开画布右栏。");
    } catch (error) {
      win.alert(errorMessage(error));
    }
  }
  select.addEventListener("click", () => activate(canvasPaperID));
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    closeCanvas();
  });
  tab.addEventListener("click", (event) => {
    if (event.target === tab) select.click();
  });
  launch.addEventListener("click", () => activate(paperID()));
  navButton.addEventListener("click", () => activate(paperID()));
  topButton.addEventListener("click", () => activate(paperID()));

  function resumeNative(event: Event) {
    const target = event.target as Element | null;
    const control = target?.closest?.(`${nativeTab}, ${plus}, .llm-standalone-side-panel-close, .llm-standalone-side-panel-toggle`);
    if (control && control !== tab) show(false);
  }
  function resumeByKey(event: KeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") resumeNative(event);
  }
  doc.addEventListener("click", resumeNative, true);
  doc.addEventListener("keydown", resumeByKey, true);
  const observer = new win.MutationObserver(() => { if (!frame) frame = win.requestAnimationFrame(sync); });
  observer.observe(doc.documentElement, {
    childList: true, subtree: true, attributes: true,
    attributeFilter: ["aria-selected", "data-side-view", "data-sidebar-state", "data-base-paper-item-id", "data-item-id", "data-conversation-kind", "hidden"],
  });
  sync();

  function dispose() {
    observer.disconnect();
    win.cancelAnimationFrame(frame);
    doc.removeEventListener("click", resumeNative, true);
    doc.removeEventListener("keydown", resumeByKey, true);
    closeCanvas();
    launch.remove();
    navButton.remove();
    topButton.remove();
    restoreBranchBubbles(doc);
    css.remove();
  }
  return { open, dispose };
}

export function watchLLMWindows(receiver: Receiver) {
  const windows = new Map<HostWindow, { dispose(): void; open?(itemID: number): boolean }>();
  const waiting = new Map<HostWindow, () => void>();
  let stopped = false;
  function attachIfReady(win: HostWindow) {
    if (stopped || win.closed || windows.has(win)) return;
    const url = win.document.URL;
    if (url === chatURL) windows.set(win, attach(win, receiver));
    if (url === "chrome://zotero/content/zoteroPane.xhtml" || url === "chrome://zotero/content/reader.xhtml") {
      windows.set(win, attachReader(win, receiver));
    }
  }
  function watch(win: HostWindow) {
    attachIfReady(win);
    if (waiting.has(win) || windows.has(win)) return;
    const load = (event: Event) => {
      if (event.target !== win.document) return;
      unwatch();
      attachIfReady(win);
    };
    const unwatch = () => {
      win.removeEventListener("load", load);
      waiting.delete(win);
    };
    waiting.set(win, unwatch);
    win.addEventListener("load", load);
  }
  const listener = {
    observe(subject: nsISupports, topic: string) {
      const win = subject as unknown as HostWindow;
      if (topic === "domwindowopened") watch(win);
      if (topic === "domwindowclosed") {
        waiting.get(win)?.();
        windows.get(win)?.dispose();
        windows.delete(win);
      }
    },
  };
  Services.ww.registerNotification(listener as nsIObserver);
  for (const win of Services.wm.getEnumerator("")) attachIfReady(win as unknown as HostWindow);

  return {
    async openPaper(itemID: number) {
      const main = Zotero.getMainWindow();
      const shortcut = main?.document.getElementById("llmforzotero-key-standalone");
      if (!main || !shortcut) throw new Error("请先启用 LLM for Zotero。");
      const upstreamWindow = () => companionGlobals().LLMForZotero?.data?.standaloneWindow as HostWindow | undefined;
      if (!upstreamWindow() || upstreamWindow()?.closed) shortcut.dispatchEvent(new main.Event("command"));
      const deadline = Date.now() + 8000;
      while (!stopped && Date.now() < deadline) {
        const win = upstreamWindow();
        if (win && !win.closed) {
          attachIfReady(win);
          if (windows.get(win)?.open?.(itemID)) {
            win.focus();
            return;
          }
        }
        await Zotero.Promise.delay(80);
      }
      throw new Error("无法打开 LLM for Zotero 的画布右栏。");
    },
    dispose() {
      stopped = true;
      Services.ww.unregisterNotification(listener as nsIObserver);
      for (const unwatch of waiting.values()) unwatch();
      for (const integration of windows.values()) integration.dispose();
      windows.clear();
    },
  };
}
