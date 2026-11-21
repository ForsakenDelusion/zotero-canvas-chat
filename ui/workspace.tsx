import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, MarkerType, MiniMap, ReactFlow, SelectionMode,
  useNodesInitialized, useReactFlow, useViewport, type Edge, type NodeChange,
} from "@xyflow/react";
import {
  BookOpen, Check, Combine, Focus, GitFork, LibraryBig,
  ListTree, LoaderCircle, Maximize, Minus, Network, Plus,
  Redo2, Settings2, Sparkles, Trash2, Undo2,
} from "lucide-react";
import { ancestors } from "../shared/graph";
import type { Command, Position, Snapshot } from "../shared/schema";
import type { Bridge } from "./bridge";
import { CardNode, CardPreview, cardActions, type FlowCard } from "./cards";
import { QuestionComposer, type Composer } from "./composer";
import { Dialog, LibraryDialog, SettingsDialog } from "./dialogs";
import { organizeCards } from "./layout";

const nodeTypes = { card: CardNode };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
type OpenQuestion = Composer & {
  conversationKey: Snapshot["conversationKey"]; draftKey: string;
  request: string; mode: "pending" | "native" | "canvas"; source?: string;
};

export function Workspace({ bridge, initial }: { bridge: Bridge; initial: Snapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  const [selected, setSelected] = useState<string[]>([]);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [measurements, setMeasurements] = useState<Record<string, FlowCard["measured"]>>({});
  const [question, setQuestion] = useState<OpenQuestion>();
  const questionSequence = useRef(0);
  const questionKeys = useRef(new Map<string, string>());
  const drafts = useRef(new Map<string, string>());
  const [modal, setModal] = useState<"settings" | "library" | "remove" | { cardId: string; trigger: HTMLButtonElement }>();
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [crystallizing, setCrystallizing] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [focusId, setFocusId] = useState("");
  const [showMap, setShowMap] = useState(false);
  const [canvasVisible, setCanvasVisible] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const flow = useReactFlow<FlowCard, Edge>();
  const nodesInitialized = useNodesInitialized();
  const viewport = useViewport();
  const noticeTimer = useRef<number | undefined>(undefined);
  const firstFrame = useRef(true);
  const shownConversation = useRef(initial.conversationKey);
  const cards = snapshot.document.cards;
  const lastTurn = cards.findLast((card) => card.importedTurn && card.status === "done") ??
    cards.findLast((card) => card.importedTurn);
  const hasCards = cards.length > 0;
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const path = useMemo(() => {
    const available = new Set(cards.map((card) => card.id));
    return new Set(ancestors(snapshot.document, selected.filter((id) => available.has(id))).map((card) => card.id));
  }, [snapshot.document, cards, selected]);

  const report = useCallback((text: string, error = false) => {
    setNotice({ text, error });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(undefined), error ? 6500 : 3200);
  }, []);

  const act = useCallback(async (command: Command) => {
    try { await bridge.call(command); }
    catch (error) { report(errorMessage(error), true); }
  }, [bridge, report]);

  useEffect(() => bridge.subscribe((event) => {
    if (event.type === "snapshot") setSnapshot(event.snapshot);
    if (event.type === "card") setSnapshot((state) => ({
      ...state, saved: false, document: {
        ...state.document,
        cards: state.document.cards.map((card) => card.id === event.card.id ? event.card : card),
      },
    }));
    if (event.type === "focus") setFocusId(event.id);
    if (event.type === "composerClosed") {
      const key = questionKeys.current.get(event.request);
      questionKeys.current.delete(event.request);
      if (key) {
        if (event.draft) drafts.current.set(key, event.draft);
        else drafts.current.delete(key);
      }
      setQuestion((current) => current?.request === event.request ? undefined : current);
    }
  }), [bridge]);

  useEffect(() => {
    void bridge.call({ type: "ready" }).then(setSnapshot).catch((error) => report(errorMessage(error), true));
    const demoSource = () => report("演示 PDF 第 4 页");
    window.addEventListener("zcanvas:demo-source", demoSource);
    return () => {
      window.clearTimeout(noticeTimer.current);
      window.removeEventListener("zcanvas:demo-source", demoSource);
    };
  }, [bridge, report]);

  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setCanvasVisible(entry.contentRect.width > 0 && entry.contentRect.height > 0);
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const changedConversation = shownConversation.current !== snapshot.conversationKey;
    if (changedConversation) {
      shownConversation.current = snapshot.conversationKey;
      firstFrame.current = true;
      setSelected([]);
      setFocusId("");
      setQuestion((current) => current?.mode === "canvas" ? undefined : current);
      drafts.current.clear();
      setModal(undefined);
    }
    const surface = canvas.current;
    if (!canvasVisible || !surface?.clientWidth || !surface.clientHeight || !nodesInitialized || !flow.viewportInitialized) return;
    if (focusId && !changedConversation) {
      const node = flow.getNode(focusId);
      if (node) {
        if (!node.measured?.width || !node.measured.height) return;
        firstFrame.current = false;
        setSelected([focusId]);
        setFocusId("");
        void flow.fitView({ nodes: [node], padding: 0.24, maxZoom: 1, duration: 250 });
        return;
      }
    }
    if (!firstFrame.current) return;
    firstFrame.current = false;
    const { x, y, zoom } = flow.getViewport();
    const visible = flow.getNodes().filter((node) => {
      const bounds = flow.getNodesBounds([node.id]);
      const left = bounds.x * zoom + x;
      const top = bounds.y * zoom + y;
      return left < surface.clientWidth && top < surface.clientHeight
        && left + bounds.width * zoom > 0 && top + bounds.height * zoom > 0;
    });
    const defaultView = !x && !y && zoom === 1;
    if (lastTurn && (defaultView || !visible.some((node) => node.data.importedTurn))) {
      void flow.fitView({ nodes: [{ id: lastTurn.id }], padding: 0.28, maxZoom: 1 });
    } else if (defaultView || !visible.length) {
      void flow.fitView({ padding: 0.3, maxZoom: 1 });
    }
  }, [canvasVisible, nodesInitialized, flow, focusId, snapshot.conversationKey, lastTurn?.id]);

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input,textarea,select,[contenteditable],dialog")) return;
      event.preventDefault();
      void act({ type: event.shiftKey ? "redo" : "undo" });
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [act]);

  const openQuestion = useCallback((parents: string[], anchor: Composer["anchor"], quote?: string, trigger?: HTMLButtonElement) => {
    const conversationKey = snapshot.conversationKey;
    const draftKey = JSON.stringify([conversationKey, [...parents].sort(), quote]);
    const request = String(++questionSequence.current);
    const source = parents.length === 1 ? cards.find((card) => card.id === parents[0])?.title :
      parents.length ? `${parents.length} 张卡片` : undefined;
    setQuestion({ parents, quote, anchor, trigger, conversationKey, draftKey, request, mode: "pending", source });
    questionKeys.current.set(request, draftKey);
    const bounds = anchor();
    void bridge.call({
      type: "openComposer", request, parents, quote, source, draft: drafts.current.get(draftKey) ?? "",
      anchor: bounds && { left: bounds.left, top: bounds.top, bottom: bounds.bottom },
    }).then((opened) => {
      if (!opened) questionKeys.current.delete(request);
      setQuestion((current) => current?.request === request ? { ...current, mode: opened ? "native" : "canvas" } : current);
    }).catch((error) => {
      questionKeys.current.delete(request);
      setQuestion((current) => current?.request === request ? undefined : current);
      report(errorMessage(error), true);
    });
  }, [bridge, cards, report, snapshot.conversationKey]);

  useEffect(() => {
    const request = question?.request;
    if (!request) return;
    return () => { void bridge.call({ type: "closeComposer", request }).catch(() => undefined); };
  }, [bridge, question?.request]);

  useEffect(() => {
    if (question?.mode !== "native") return;
    const dismiss = (event: PointerEvent) => {
      if (question.trigger?.contains(event.target as Node)) return;
      setQuestion(undefined);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [question]);
  const ask = useCallback((id: string, anchor: Composer["anchor"], quote?: string, trigger?: HTMLButtonElement) => {
    openQuestion([id], anchor, quote, trigger);
  }, [openQuestion]);
  const actions = useMemo(() => ({
    ask, call: bridge.call, expand(cardId: string, trigger: HTMLButtonElement) {
      setQuestion(undefined);
      setModal({ cardId, trigger });
    },
  }), [ask, bridge.call]);

  const nodes = useMemo<FlowCard[]>(() => cards.map((card) => ({
    id: card.id, type: "card", data: card, position: positions[card.id] || { x: card.x, y: card.y },
    measured: measurements[card.id], selected: selectedSet.has(card.id),
  })), [cards, positions, measurements, selectedSet]);

  const edges = useMemo<Edge[]>(() => cards.flatMap((card) => card.parents.map((parent) => {
    const highlighted = path.has(card.id) && path.has(parent);
    const color = highlighted ? "var(--accent)" : "var(--edge)";
    return {
      id: `${parent}-${card.id}`, source: parent, target: card.id, type: "default",
      sourceHandle: card.importedTurn ? "next-turn" : undefined,
      targetHandle: card.importedTurn ? "previous-turn" : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 11, height: 11 },
      style: { stroke: color, strokeWidth: highlighted ? 1.8 : 1.25 },
    };
  })), [cards, path]);

  function changeNodes(changes: NodeChange<FlowCard>[]) {
    const dimensions = changes.filter((change) => change.type === "dimensions");
    if (dimensions.length) setMeasurements((current) => {
      const next = { ...current };
      for (const change of dimensions) if (change.dimensions) next[change.id] = change.dimensions;
      return next;
    });
    const moves = changes.filter((change) => change.type === "position");
    if (moves.length) setPositions((current) => {
      const next = { ...current };
      for (const move of moves) if (move.position) next[move.id] = move.position;
      return next;
    });
    const selections = changes.filter((change) => change.type === "select");
    if (selections.length) setSelected((current) => {
      const next = new Set(current);
      for (const selection of selections) {
        if (selection.selected) next.add(selection.id);
        else next.delete(selection.id);
      }
      return [...next];
    });
  }

  async function crystallize(ids: string[]) {
    setCrystallizing(true);
    try {
      await bridge.call({ type: "crystallize", ids });
      report("阅读笔记已保存到当前文献。");
    } catch (error) { report(errorMessage(error), true); }
    finally { setCrystallizing(false); }
  }

  const active = selected.filter((id) => cards.some((card) => card.id === id));
  const canRemove = !cards.some((card) => selectedSet.has(card.id) && card.importedTurn);
  const pendingPath = cards.some((card) => path.has(card.id) && card.status === "streaming");
  const connectionText = snapshot.saveError || (snapshot.saved ? "已保存" : "保存中");
  const fit = () => void flow.fitView({ padding: 0.24, duration: 240, maxZoom: 1.05 });
  async function organize() {
    const measuredCards = [];
    for (const card of cards) {
      const size = flow.getNode(card.id)?.measured;
      if (!size?.width || !size.height) return;
      measuredCards.push({ ...card, width: size.width, height: size.height });
    }
    const moved = organizeCards(measuredCards).filter((position, index) =>
      position.x !== cards[index].x || position.y !== cards[index].y);
    setOrganizing(true);
    try {
      if (moved.length) await bridge.call({ type: "move", positions: moved });
      if (shownConversation.current !== snapshot.conversationKey) return;
      setPositions({});
      fit();
    } catch (error) { report(errorMessage(error), true); }
    finally { setOrganizing(false); }
  }

  const close = () => {
    if (typeof modal === "object") {
      setQuestion(undefined);
      modal.trigger.focus({ preventScroll: true });
    }
    setModal(undefined);
  };
  const preview = typeof modal === "object" ? cards.find((card) => card.id === modal.cardId) : undefined;
  const composer = question?.mode === "canvas" && question.conversationKey === snapshot.conversationKey && question.parents.every(
    (id) => cards.some((card) => card.id === id),
  ) ? question : undefined;
  const mainConversation = Boolean(composer && !composer.parents.length && composer.conversationKey);
  const blocked = composer?.parents.length ? ancestors(snapshot.document, composer.parents).some((card) => card.status === "streaming") : false;

  function askFromButton(parents: string[], trigger: HTMLButtonElement) {
    openQuestion(parents, () => trigger.isConnected ? trigger.getBoundingClientRect() : undefined, undefined, trigger);
  }

  const questionForm = composer && <QuestionComposer key={composer.draftKey} composer={composer} source={composer.source} blocked={blocked}
    mainConversation={mainConversation} draft={drafts.current.get(composer.draftKey) ?? ""}
    updateDraft={(prompt) => {
      if (prompt) drafts.current.set(composer.draftKey, prompt);
      else drafts.current.delete(composer.draftKey);
    }}
    close={() => setQuestion((current) => current === composer ? undefined : current)}
    submit={async (prompt) => {
      if (!composer.parents.length && composer.conversationKey) {
        await bridge.call({ type: "askConversation", key: composer.conversationKey, prompt });
        report("已发送到论文对话。");
      } else {
        await bridge.call({ type: "branch", parents: composer.parents, quote: composer.quote, prompt });
      }
      if (drafts.current.get(composer.draftKey)?.trim() === prompt) drafts.current.delete(composer.draftKey);
      setQuestion((current) => current === composer ? undefined : current);
    }} />;

  return <div className="shell">
    <header className="topbar">
      <div className="paper"><BookOpen size={17} /><span title={snapshot.paper.title}>{snapshot.paper.title}</span></div>
      <div className="top-actions">
        {import.meta.env.DEV && <span className="preview-label">演示</span>}
        {snapshot.saveError
          ? <button className="save-status" title={connectionText} onClick={() => void act({ type: "save" })}>重试保存</button>
          : <span className="save-status" role="status">{connectionText}</span>}
        <button className="icon-button" title="引用本地文献" aria-label="引用本地文献"
          onClick={() => setModal("library")}><LibraryBig size={17} /></button>
        <button className="icon-button" title="模型设置" aria-label="模型设置" onClick={() => setModal("settings")}><Settings2 size={18} /></button>
      </div>
    </header>
    <div className="workspace">
      <main className="board" aria-label="阅读画布">
        <div className="board-top">
          <div className="tool-group">
            <button className="icon-button new-question" title="新建问题" aria-label="新建问题"
              onClick={(event) => askFromButton([], event.currentTarget)}><Plus size={17} /></button>
            <button className="icon-button organize-cards" title="整理卡片" aria-label="整理卡片"
              disabled={cards.length < 2 || !nodesInitialized || organizing}
              onClick={() => void organize()}><ListTree size={17} /></button>
            <button className="icon-button" title="撤销" aria-label="撤销" disabled={!snapshot.undo} onClick={() => void act({ type: "undo" })}><Undo2 size={17} /></button>
            <button className="icon-button" title="重做" aria-label="重做" disabled={!snapshot.redo} onClick={() => void act({ type: "redo" })}><Redo2 size={17} /></button>
          </div>
          {active.length > 0 && <div className="tool-group selection-tools">
            <span>{active.length} 张已选</span>
            <button disabled={pendingPath} onClick={(event) => askFromButton(active, event.currentTarget)}>
              {active.length > 1 ? <Combine size={16} /> : <GitFork size={16} />}
              {active.length > 1 ? "汇聚" : "追问"}
            </button>
            <button disabled={pendingPath || crystallizing} onClick={() => void crystallize(active)}>
              {crystallizing ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
              {crystallizing ? "生成笔记中" : "总结所选卡片为笔记"}
            </button>
            {canRemove && <button className="icon-button" title="移除卡片" aria-label="移除卡片" onClick={() => setModal("remove")}><Trash2 size={15} /></button>}
          </div>}
        </div>
        <div className="board-flow" ref={canvas}>
          <cardActions.Provider value={actions}>
            <ReactFlow<FlowCard, Edge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={changeNodes}
              onNodeDragStop={(_event, node, dragged) => {
                const moved = (dragged.length ? dragged : [node]).map((item) => ({ id: item.id, ...item.position }));
                void act({ type: "move", positions: moved }).then(() => setPositions({}));
              }}
              defaultViewport={initial.document.viewport} onMoveEnd={(_event, value) => void act({ type: "viewport", viewport: value })}
              minZoom={0.15} maxZoom={2} deleteKeyCode={null} multiSelectionKeyCode="Shift"
              selectionMode={SelectionMode.Partial} selectionOnDrag={false} panOnDrag
              nodesDraggable={!organizing} nodesConnectable={false} edgesFocusable={false} autoPanOnNodeDrag proOptions={{ hideAttribution: true }}>
              <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--grid)" />
              {hasCards && showMap && <MiniMap position="bottom-right" pannable zoomable ariaLabel="画布小地图"
                nodeColor="var(--edge)" maskColor="var(--hover)" />}
            </ReactFlow>
          </cardActions.Provider>
          {!hasCards && <div className="empty">
            <Network size={22} aria-hidden="true" />
            <p>论文对话会在这里形成卡片。<br />也可以从 PDF 划词开始。</p>
          </div>}
        </div>
        <div className="board-bottom">
          <div className="tool-group zoom">
            <button className="icon-button" title="缩小" aria-label="缩小" onClick={() => void flow.zoomOut()}><Minus size={16} /></button>
            <span className="zoom-value">{Math.round(viewport.zoom * 100)}%</span>
            <button className="icon-button" title="放大" aria-label="放大" onClick={() => void flow.zoomIn()}><Plus size={16} /></button>
            <button className="icon-button" title="适应画布" aria-label="适应画布" disabled={!nodesInitialized} onClick={fit}><Focus size={16} /></button>
            <button className="icon-button" title={showMap ? "隐藏小地图" : "显示小地图"} aria-label={showMap ? "隐藏小地图" : "显示小地图"}
              onClick={() => setShowMap((value) => !value)}><Maximize size={15} /></button>
          </div>
        </div>
        {notice && <div className={`toast${notice.error ? " toast-error" : ""}`} role={notice.error ? "alert" : "status"}>
          {!notice.error && <Check size={17} />}{notice.text}
        </div>}
      </main>
    </div>
    {preview ? <cardActions.Provider value={actions}>
      <CardPreview key={preview.id} card={preview} close={close}>{questionForm}</CardPreview>
    </cardActions.Provider> : questionForm}
    {modal === "settings" && <SettingsDialog value={snapshot.settings} companionAvailable={snapshot.companionAvailable} close={close}
      save={(settings, key) => bridge.call({ type: "settings", settings, key })} />}
    {modal === "library" && <LibraryDialog call={bridge.call} close={close} />}
    {modal === "remove" && <Dialog title="移除选中的卡片" close={close}>
      <p className="muted">依赖这些卡片的下游分支也会移除。此操作可以撤销。</p>
      <div className="dialog-actions"><button className="secondary" onClick={close}>取消</button>
        <button className="danger" onClick={() => {
          void act({ type: "remove", ids: active });
          setSelected([]);
          close();
        }}>移除</button></div>
    </Dialog>}
  </div>;
}
