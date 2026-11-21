import { conversationCards } from "../shared/graph";
import { errorMessage, requestSchema, type Excerpt, type Snapshot } from "../shared/schema";
import { hostColors, type CanvasTheme } from "../shared/theme";
import { makeAnchor, migrateLegacyNotes, parentPaper, zoteroHost } from "./library";
import { conversationAt, observeConversation } from "./llm-turn";
import { watchLLMWindows } from "./llm-window";
import { nativeCitations } from "./native-citations";
import { nativeComposer } from "./native-composer";
import { readerHooks } from "./reader";
import { CanvasSession } from "./session";

const content = "chrome://zotero-canvas-chat/content/";
const htmlNamespace = "http://www.w3.org/1999/xhtml";
const sessions = new Map<number, CanvasSession>();
const mounts = new Set<() => void>();
let unregisterReader: (() => void) | undefined;
let injectedUI: ReturnType<typeof watchLLMWindows> | undefined;

function sessionFor(paper: Zotero.Item) {
  let session = sessions.get(paper.id);
  if (!session) {
    const win = Zotero.getMainWindow();
    if (!win) throw new Error("无法连接 Zotero 文献库。");
    session = new CanvasSession(zoteroHost(paper, win));
    sessions.set(paper.id, session);
  }
  return session;
}

function mountPaper(itemID: number, container: Element, onDetach: () => void) {
  const paper = parentPaper(Zotero.Items.get(itemID));
  const win = container.ownerDocument.defaultView;
  if (!paper || !win) throw new Error("找不到画布对应的文献或窗口。");
  const session = sessionFor(paper);
  const iframe = container.ownerDocument.createElementNS(htmlNamespace, "iframe") as HTMLIFrameElement;
  iframe.setAttribute("sandbox", "allow-scripts allow-forms");
  iframe.setAttribute("title", "Canvas Chat 阅读画布");
  iframe.setAttribute("style", "width:100%;height:100%;min-height:0;flex:1;border:0;display:block;");
  const connection = `zcanvas:${win.crypto.randomUUID()}`;
  const url = `${content}canvas/index.html#${connection}`;
  const deadline = Date.now() + 8000;
  let port: MessagePort | undefined;
  let timer: number | undefined;
  let pendingFocus: { type: "focus"; id: string } | undefined;
  let conversationKey = 0;
  let turnIDs = new Set<string>();
  let branchTurns = new Map<string, string>();
  let visibleIDs = new Set<string>();
  let syncing: Promise<void> = Promise.resolve();
  let connected = true;
  const root = container.ownerDocument.documentElement;
  const themeRoot = container.closest("#llmforzotero-standalone-chat-root");
  const darkMode = win.matchMedia("(prefers-color-scheme: dark)");
  const sendTheme = () => {
    if (!port) return;
    const computed = win.getComputedStyle(container);
    const mode = themeRoot?.getAttribute("data-standalone-theme");
    const theme: CanvasTheme = {
      dark: !mode ? root.classList.contains("window-is-dark") || darkMode?.matches === true : mode === "dark",
      colors: {},
    };
    for (const key of Object.keys(hostColors) as (keyof typeof hostColors)[]) {
      theme.colors[key] = computed?.getPropertyValue(hostColors[key]).trim();
    }
    port.postMessage({ theme });
  };
  const themeObserver = new win.MutationObserver(sendTheme);
  const themeAttributes = { attributes: true, attributeFilter: ["class", "style", "lwtheme-brighttext", "data-standalone-theme"] };
  themeObserver.observe(root, themeAttributes);
  if (themeRoot && themeRoot !== root) themeObserver.observe(themeRoot, themeAttributes);
  darkMode?.addEventListener("change", sendTheme);
  const project = (snapshot: Snapshot): Snapshot => {
    const cards = conversationCards(snapshot.document.cards, turnIDs, conversationKey, new Set(branchTurns.keys()));
    visibleIDs = new Set(cards.map((card) => card.id));
    return { ...snapshot, conversationKey, document: { ...snapshot.document, cards } };
  };
  const unsubscribe = session.subscribe((event) => {
    if (port && event.type === "snapshot") port.postMessage({ event: { ...event, snapshot: project(event.snapshot) } });
    else if (port && event.type === "card" && visibleIDs.has(event.card.id)) port.postMessage({ event });
    else if (port && event.type === "focus" && visibleIDs.has(event.id)) port.postMessage({ event });
    else if (!port && event.type === "focus") pendingFocus = event;
  });
  const composer = nativeComposer(container, iframe, paper.id, session, (request, draft) => {
    if (connected) port?.postMessage({ event: { type: "composerClosed", request, draft } });
  });
  const citations = nativeCitations(container, iframe, paper.id, (event) => {
    if (connected) port?.postMessage({ event });
  });
  const stopObserving = observeConversation(container, paper.id, (key, turns, partial) => {
    const entries = turns.map((turn) => ({
      id: `${key}:${turn.timestamp}`, prompt: turn.question || "论文对话", answer: turn.answer,
      sources: sourceAnchors(paper, turn.sources), messageIndex: turn.messageIndex,
      stopped: turn.stopped, branchID: turn.branchID, quotedTexts: turn.quotedTexts,
    }));
    if (conversationKey !== key) citations.reset();
    if (!partial || conversationKey !== key) {
      turnIDs = new Set();
      branchTurns = new Map();
    }
    for (const turn of entries) {
      turnIDs.add(turn.id);
      if (turn.branchID) branchTurns.set(turn.branchID, turn.id);
    }
    conversationKey = key;
    syncing = session.syncConversation(entries, partial).then(async () => {
      if (!port || !connected) return;
      const snapshot = project(await session.ready());
      if (connected) port?.postMessage({ event: { type: "snapshot", snapshot } });
    }).catch((error) => Zotero.logError(error));
  });
  const connect = () => {
    const target = iframe.contentWindow;
    const document = target?.document;
    if (!target || !document || document.URL !== url || document.readyState === "loading") {
      if (Date.now() < deadline) timer = win.setTimeout(connect, 30);
      return;
    }
    const channel = new (win as Window & typeof globalThis).MessageChannel();
    port = channel.port1;
    const reply = channel.port1;
    reply.onmessage = async (message) => {
      const parsed = requestSchema.safeParse((message as MessageEvent).data);
      if (!parsed.success) return;
      const { id, command } = parsed.data;
      try {
        let value;
        if (command.type === "ready") {
          await syncing;
          value = project(await session.ready());
        } else if (command.type === "openComposer") {
          if (conversationKey && conversationAt(container, paper.id)?.key !== conversationKey) {
            throw new Error("当前论文对话已切换。请重新打开提问框。");
          }
          if (command.parents.some((id) => !visibleIDs.has(id))) throw new Error("来源卡片已不在当前画布。");
          citations.dismiss();
          composer.open(command);
        } else if (command.type === "closeComposer") {
          composer.close(command.request);
        } else if (command.type === "readCitedAnswer") {
          const key = conversationKey;
          await syncing;
          const snapshot = await session.ready();
          const card = snapshot.document.cards.find((entry) => entry.id === command.id);
          const turn = card?.importedTurn ?? card?.nativeTurn ?? branchTurns.get(command.id);
          value = connected && key === conversationKey && visibleIDs.has(command.id) && turn
            ? citations.read(turn) : null;
        } else if (command.type === "openAnswerCitation") {
          citations.open(command);
        } else if (command.type === "closeAnswerCitation") {
          citations.dismiss(command.prefix);
        } else if (command.type === "crystallize") {
          const currentKey = conversationAt(container, paper.id)?.key ?? 0;
          if (!currentKey || (conversationKey && currentKey !== conversationKey)) {
            throw new Error(conversationKey ? "当前论文对话已切换。请重试。" : "请先在 LLM for Zotero 中打开这篇文献的论文对话。");
          }
          if (command.ids.some((id) => !visibleIDs.has(id))) throw new Error("选中的卡片已不在当前画布。");
          citations.dismiss();
          composer.close();
          value = await session.crystallize(
            command.ids,
            currentKey,
            (payload, onSent) => composer.summarize(currentKey, payload, onSent),
          );
        } else value = await session.command(command);
        reply.postMessage({ id, ok: true, value });
      } catch (error) {
        reply.postMessage({ id, ok: false, error: errorMessage(error).slice(0, 1000) });
      }
    };
    target.postMessage(connection, "*", [channel.port2]);
    sendTheme();
    if (pendingFocus) reply.postMessage({ event: pendingFocus });
    pendingFocus = undefined;
  };
  const detach = () => {
    unmount();
    onDetach();
  };
  const unmount = () => {
    if (!mounts.delete(detach)) return;
    connected = false;
    composer.close();
    citations.reset();
    win.clearTimeout(timer);
    stopObserving();
    themeObserver.disconnect();
    darkMode?.removeEventListener("change", sendTheme);
    unsubscribe();
    port?.close();
    iframe.remove();
  };
  mounts.add(detach);
  iframe.src = url;
  container.append(iframe);
  timer = win.setTimeout(connect, 30);
  return unmount;
}

function sourceAnchors(paper: Zotero.Item, entries: { attachmentID: number; pageIndex: number }[]) {
  const sources = new Map<string, ReturnType<typeof makeAnchor>>();
  for (const source of entries) {
    const attachment = Zotero.Items.get(source.attachmentID);
    if (!attachment || attachment.deleted || attachment.libraryID !== paper.libraryID || !attachment.isPDFAttachment()) continue;
    const anchor = makeAnchor(attachment, source.pageIndex);
    sources.set(anchor.uri, anchor);
  }
  return [...sources.values()];
}

function llmForZoteroInstalled() {
  return Boolean((Zotero as typeof Zotero & { LLMForZotero?: unknown }).LLMForZotero);
}

function openFromReader(paper: Zotero.Item, excerpt?: Excerpt) {
  void (async () => {
    await injectedUI?.openPaper(paper.id);
    if (excerpt) await sessionFor(paper).addExcerpt(excerpt);
  })().catch((error) => Zotero.getMainWindow()?.alert(errorMessage(error)));
}

export function startup(id: string) {
  injectedUI = watchLLMWindows({ mountPaper });
  unregisterReader = readerHooks(id, openFromReader, llmForZoteroInstalled);
  void migrateLegacyNotes().catch(() => undefined);
}

export async function shutdown() {
  unregisterReader?.();
  injectedUI?.dispose();
  injectedUI = undefined;
  for (const detach of mounts) detach();
  await Promise.all([...sessions.values()].map((session) => session.close()));
  sessions.clear();
}
