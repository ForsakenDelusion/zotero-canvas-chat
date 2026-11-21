import { errorMessage } from "../shared/schema";
import { readNativePrompt } from "../shared/question";
import { parentPaper } from "./library";

type Receiver = {
  mountPaper(itemID: number, container: Element, onDetach: () => void): () => void;
};
type HostWindow = Window & typeof globalThis;
type LLMForZoteroGlobal = typeof Zotero & {
  LLMForZotero?: { data?: { standaloneWindow?: Window } };
};
const chatURL = "chrome://llmforzotero/content/standaloneChat.xhtml";
const rightPanel = "#llm-standalone-side-panel";
const panelView = ".llm-standalone-side-panel-view";
const nativeTab = ".llm-standalone-side-panel-tab";
const plus = ".llm-standalone-side-panel-icon-new-tab";
const paperChat = "#llm-main[data-conversation-kind='paper']";
const chatBody = ".llm-standalone-content #llm-main";
const readerChat = `#zotero-context-pane-item-deck ${paperChat}, item-details[tabType="reader"] ${paperChat}`;
const sidebarToggle = ".llm-standalone-side-panel-toggle";
const branchContext = ".zcanvas-branch-context";
const html = "http://www.w3.org/1999/xhtml";
const workspaceHostSelector = ".llm-standalone-content-wrapper";
const activeWorkspace = `${workspaceHostSelector}[data-zcanvas-workspace]`;
const minSplitChatWidth = 500;
const minSideCanvasWidth = 320;
const defaultSideCanvasWidth = 420;
const sidePanelDividerWidth = 5;

function element(doc: Document, name: "button", text: string): HTMLButtonElement;
function element(doc: Document, name: "div" | "span" | "style", text?: string): HTMLElement;
function element(doc: Document, name: string, text = "") {
  const node = doc.createElementNS(html, name);
  node.textContent = text;
  return node;
}

function paperIDFor(chat: HTMLElement | null) {
  if (!chat?.matches(paperChat)) return 0;
  const id = Number(chat.dataset.basePaperItemId || chat.dataset.itemId || 0);
  return id > 0 ? parentPaper(Zotero.Items.get(id))?.id ?? 0 : 0;
}

function syncUserBubbleWidth(bubble: Element) {
  const wrapper = bubble.closest<HTMLElement>(".llm-message-wrapper.user.llm-user-context-aligned");
  if (!wrapper) return;
  const width = Math.round(bubble.getBoundingClientRect().width);
  if (width > 0) wrapper.style.setProperty("--llm-user-bubble-width", `${width}px`);
  else wrapper.style.removeProperty("--llm-user-bubble-width");
}

function compactBranchBubbles(doc: Document) {
  doc.querySelectorAll(`${paperChat} .llm-bubble.user`).forEach((bubble) => {
    if (bubble.querySelector(branchContext)) {
      syncUserBubbleWidth(bubble);
      return;
    }
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
    syncUserBubbleWidth(bubble);
  });
}

function restoreBranchBubbles(doc: Document) {
  doc.querySelectorAll(branchContext).forEach((material) => {
    const bubble = material.parentElement;
    material.replaceWith(material.textContent ?? "");
    bubble?.normalize();
    if (bubble) syncUserBubbleWidth(bubble);
  });
}

function attachReader(win: HostWindow, receiver: Receiver) {
  const doc = win.document;
  const zh = Zotero.locale.startsWith("zh");
  const css = element(doc, "style", `
    #llm-main .llm-header-actions > .zcanvas-reader-button {
      flex: none; width: auto; min-width: 0; color: var(--fill-primary); opacity: 1; height: 24px; padding-inline: 6px;
      border-radius: 6px; white-space: nowrap;
      font: inherit; font-weight: 600; font-size: var(--llm-fs-11, 11px);
    }
    #llm-main .llm-header-actions > .zcanvas-reader-button:is(:hover, [aria-pressed="true"]) { background: var(--fill-quinary); }
    #llm-main[data-zcanvas-reader-active] > :not(.llm-header, .zcanvas-reader-content, [data-zcanvas-composer], [data-zcanvas-menu]) { display: none !important; }
    #llm-main[data-zcanvas-reader-active][data-zcanvas-quote-probe] > #llm-chat-box {
      display: block !important; position: fixed !important; left: -99999px !important; top: 0 !important;
      width: 400px !important; opacity: 0 !important; pointer-events: none !important;
    }
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
  const resizeTo = win.resizeTo;
  const resizeDescriptor = Object.getOwnPropertyDescriptor(win, "resizeTo");
  const resizeWindow: Window["resizeTo"] = (width, height) => {
    if (win.fullScreen || win.windowState === win.STATE_FULLSCREEN) return;
    resizeTo.call(win, width, height);
  };
  if (Zotero.isMac) win.resizeTo = resizeWindow;
  const css = element(doc, "style", `
    ${activeWorkspace} { position: relative; }
    ${activeWorkspace} > :is(.llm-standalone-content-title, .llm-follower-kind-row),
    ${activeWorkspace} > .llm-standalone-tab-row > :is(.llm-standalone-tab-group, .llm-standalone-tab-row-trailing),
    ${activeWorkspace} ~ :is(${rightPanel}, .llm-standalone-side-panel-resizer) { display: none !important; }
    ${activeWorkspace} > .llm-standalone-content { visibility: hidden; }
    ${activeWorkspace} :is([data-zcanvas-composer], [data-zcanvas-menu]) { visibility: visible; }
    .zcanvas-workspace {
      position: absolute; inset: var(--llm-standalone-toolbar-row-height, 36px) 0 0; z-index: 1;
      background: var(--material-sidepane); color: var(--fill-primary);
    }
    .llm-standalone-title-action.zcanvas-back {
      min-height: 0; height: 26px; width: auto; padding-inline: 8px; font: inherit;
      white-space: nowrap; font-size: var(--llm-standalone-ui-font-size, 12px); -moz-window-dragging: no-drag;
    }
    .zcanvas-nav[aria-pressed="true"] { background: var(--fill-quinary); color: var(--fill-primary); }
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
    .zcanvas-top[aria-pressed="true"] {
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
    .llm-standalone-title-action:is(.zcanvas-top, .zcanvas-back)::before { content: none !important; }
  `);
  (doc.head ?? doc.documentElement).append(css);
  const navButton = element(doc, "button", "");
  navButton.type = "button";
  navButton.className = "llm-standalone-nav-row zcanvas-nav";
  navButton.title = zh ? "切换到画布视图" : "Switch to canvas view";
  navButton.setAttribute("aria-controls", "zcanvas-workspace");
  navButton.setAttribute("aria-pressed", "false");
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
  topButton.title = zh ? "在当前窗口打开画布" : "Open canvas in this window";
  topButton.setAttribute("aria-controls", "llm-standalone-side-panel zcanvas-workspace");
  const workspace = element(doc, "div");
  workspace.id = "zcanvas-workspace";
  workspace.className = "zcanvas-workspace";
  const back = element(doc, "button", zh ? "← 返回对话" : "← Back to chat");
  back.type = "button";
  back.className = "llm-standalone-title-action zcanvas-back";
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
  let workspaceHost: HTMLElement | undefined;
  let workspaceCanvas: { itemID: number; unmount: () => void } | undefined;
  let workspaceTrigger: HTMLButtonElement | undefined;
  let nativeSelection = "";
  let frame = 0;

  function paperID() {
    return paperIDFor(doc.querySelector<HTMLElement>(chatBody));
  }

  function canSplitCanvas() {
    const host = doc.querySelector<HTMLElement>(workspaceHostSelector);
    const sidePanel = host?.parentElement?.querySelector<HTMLElement>(rightPanel);
    if (!host || !sidePanel) return false;
    const chatWidth = host.getBoundingClientRect().width;
    if (!sidePanel.hidden) {
      return chatWidth >= minSplitChatWidth && sidePanel.getBoundingClientRect().width >= minSideCanvasWidth;
    }
    const panelWidth = Number.parseFloat(
      win.getComputedStyle(sidePanel)?.getPropertyValue("--llm-standalone-side-panel-width") ?? "",
    );
    const canvasWidth = Math.max(minSideCanvasWidth, panelWidth || defaultSideCanvasWidth);
    return chatWidth >= minSplitChatWidth + canvasWidth + sidePanelDividerWidth;
  }

  function markSideEntry(active: boolean) {
    topButton.setAttribute("aria-pressed", String(active));
  }

  function show(active: boolean) {
    panel?.toggleAttribute("data-zcanvas-active", active);
    tab.classList.toggle("active", active);
    select.setAttribute("aria-pressed", String(active));
    content.hidden = !active;
    markSideEntry(active);
  }

  function closeCanvas() {
    show(false);
    unmount?.();
    unmount = undefined;
    canvasPaperID = 0;
    content.remove();
    tab.remove();
  }

  function closeWorkspace() {
    if (!workspaceHost) return;
    workspaceCanvas?.unmount();
    workspaceCanvas = undefined;
    workspace.remove();
    back.remove();
    workspaceHost.removeAttribute("data-zcanvas-workspace");
    workspaceHost = undefined;
    workspaceTrigger = undefined;
    navButton.setAttribute("aria-pressed", "false");
  }

  function mountWorkspace(itemID: number) {
    workspaceCanvas?.unmount();
    workspaceCanvas = undefined;
    try {
      workspaceCanvas = { itemID, unmount: receiver.mountPaper(itemID, workspace, closeWorkspace) };
    } catch (error) {
      closeWorkspace();
      win.alert(errorMessage(error));
    }
  }

  function openWorkspace(itemID: number, trigger: HTMLButtonElement) {
    const host = doc.querySelector<HTMLElement>(workspaceHostSelector);
    const leading = host?.querySelector(".llm-standalone-tab-row-leading");
    if (!itemID || !host || !leading || workspaceHost) return;
    closeCanvas();
    workspaceHost = host;
    workspaceTrigger = trigger;
    host.append(workspace);
    host.setAttribute("data-zcanvas-workspace", "");
    leading.append(back);
    navButton.setAttribute("aria-pressed", "true");
    mountWorkspace(itemID);
    if (workspaceHost) back.focus({ preventScroll: true });
  }

  function selectedNativeTab() {
    const active = panel?.querySelector<HTMLElement>(`${nativeTab}[aria-selected="true"]`);
    return `${active?.dataset.sideTabId || active?.dataset.sideTabKind || ""}:${panel?.dataset.sideView || ""}`;
  }

  function open(itemID: number) {
    if (workspaceCanvas?.itemID === itemID) return true;
    closeWorkspace();
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
    compactBranchBubbles(doc);
    const nextPanel = doc.querySelector<HTMLElement>(rightPanel);
    const chat = doc.querySelector<HTMLElement>(chatBody);
    const nextPaperID = paperIDFor(chat);
    const navigation = doc.querySelector(".llm-standalone-primary-nav");
    const toggle = doc.querySelector(sidebarToggle);
    if (workspaceHost) {
      if (!workspace.isConnected || (chat?.dataset.conversationKind && !chat.matches(paperChat))) closeWorkspace();
      else if (nextPaperID && nextPaperID !== workspaceCanvas?.itemID) mountWorkspace(nextPaperID);
    }
    if (nextPaperID && navigation) {
      if (navButton.parentElement !== navigation) navigation.append(navButton);
    } else navButton.remove();
    if (nextPaperID && nextPanel && toggle) {
      if (topButton.nextElementSibling !== toggle) toggle.before(topButton);
    } else topButton.remove();
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
  navButton.addEventListener("click", () => openWorkspace(paperID(), navButton));
  topButton.addEventListener("click", () => {
    const itemID = paperID();
    if (canSplitCanvas()) void activate(itemID);
    else openWorkspace(itemID, topButton);
  });
  back.addEventListener("click", () => {
    const trigger = workspaceTrigger;
    closeWorkspace();
    if (trigger === topButton && topButton.isConnected) {
      topButton.focus({ preventScroll: true });
      return;
    }
    const collapsed = navButton.closest('.llm-standalone-sidebar[data-sidebar-state="collapsed"]');
    const target = collapsed ? doc.querySelector<HTMLButtonElement>(".llm-standalone-nav-toggle") : navButton;
    (target ?? topButton).focus({ preventScroll: true });
  });

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
    attributeFilter: ["aria-selected", "data-side-view", "data-base-paper-item-id", "data-item-id", "data-conversation-kind", "hidden"],
  });
  sync();

  function dispose() {
    observer.disconnect();
    win.cancelAnimationFrame(frame);
    if (!win.closed && win.resizeTo === resizeWindow) {
      if (resizeDescriptor) Object.defineProperty(win, "resizeTo", resizeDescriptor);
      else Reflect.deleteProperty(win, "resizeTo");
    }
    doc.removeEventListener("click", resumeNative, true);
    doc.removeEventListener("keydown", resumeByKey, true);
    closeWorkspace();
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
      const upstreamWindow = () => (Zotero as LLMForZoteroGlobal).LLMForZotero?.data?.standaloneWindow as HostWindow | undefined;
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
