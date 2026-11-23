import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ArrowUpRight, GripHorizontal, Maximize2, Plus, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { errorMessage, type Card, type CitedAnswer } from "../shared/schema";
import type { Bridge } from "./bridge";
import { Dialog } from "./dialogs";

const kindLabels: Record<Card["kind"], string> = {
  excerpt: "PDF 摘录",
  branch: "分支",
  synthesis: "汇聚",
  citation: "文献引用",
  response: "论文对话",
};

export const cardActions = createContext<{
  call: Bridge["call"];
  lastMainId?: string;
  ask(id: string, anchor: () => DOMRect | undefined, quote?: string, trigger?: HTMLButtonElement): void;
  expand(id: string, trigger: HTMLButtonElement): void;
}>(null!);
export type FlowCard = Node<Card, "card">;

const answerCitations = createContext<{
  cited: CitedAnswer;
  expandedIndex?: number;
  activate: (index: number, trigger: HTMLButtonElement) => void;
} | undefined>(undefined);

function AnswerLink({ href, children }: { href?: string; children?: ReactNode }) {
  const citations = useContext(answerCitations);
  const suffix = href && citations && href.startsWith(citations.cited.prefix)
    ? href.slice(citations.cited.prefix.length) : "";
  const index = /^\d+$/.test(suffix) ? Number(suffix) : -1;
  if (!citations || index < 0 || index >= citations.cited.count) {
    return <span className="markdown-link">{children}</span>;
  }
  return <button type="button" className="answer-citation" aria-haspopup="dialog"
    aria-label={`支持段落 ${children}`} aria-expanded={index === citations.expandedIndex}
    onMouseUp={(event) => event.stopPropagation()}
    onClick={(event) => citations.activate(index, event.currentTarget)}>{children}</button>;
}

function CardContent({ card, call, expanded = false }: { card: Card; call: Bridge["call"]; expanded?: boolean }) {
  const [image, setImage] = useState<string | null>();
  const question = card.kind !== "excerpt" && card.kind !== "citation";
  const markdown = useContext(answerCitations)?.cited.answer ?? card.answer;
  const answer = useMemo(() => markdown && <div className="markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex, rehypeHighlight]}
      skipHtml
      disallowedElements={["img"]}
      components={{ a: AnswerLink }}
    >{markdown}</ReactMarkdown>
  </div>, [markdown]);

  useEffect(() => {
    if (!card.anchor?.image) return;
    let active = true;
    void call({ type: "image", id: card.id }).then((value) => {
      if (active) setImage(value);
    }).catch(() => { if (active) setImage(null); });
    return () => { active = false; };
  }, [call, card.id, card.anchor?.image]);

  return <>
    {expanded && (question
      ? <section className="card-preview-question">
        <h3>问题</h3>
        <p>{card.prompt || card.title}</p>
      </section>
      : <h3>{card.reference?.title ?? card.title}</h3>)}
    {card.quote && <blockquote>{card.quote}</blockquote>}
    {card.anchor?.image && (image ? <img className="excerpt-image" src={image} alt={`PDF 第 ${card.anchor.page} 页区域截图`} />
      : <p className="muted">{image === null ? "截图尚未缓存，打开原 PDF 后可重试。" : "正在读取截图…"}</p>)}
    {card.reference && <>
      <small className="muted">{[card.reference.authors, card.reference.year].filter(Boolean).join(" · ")}</small>
      <p>{card.reference.abstract || "这条文献暂无摘要。"}</p>
    </>}
    {!expanded && card.prompt && card.prompt !== card.title && <p className="card-prompt">{card.prompt}</p>}
    {expanded && question && (card.answer || card.status) && <h3>回答</h3>}
    {answer}
    {card.status === "error" && <p className="card-error" role="alert">{card.error}</p>}
    {card.status === "stopped" && <p className="muted">生成已停止。</p>}
  </>;
}

function SelectableCardBody({ card, expanded = false }: { card: Card; expanded?: boolean }) {
  const { ask, call } = useContext(cardActions);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    if (card.status !== "streaming") {
      stickToBottom.current = true;
      return;
    }
    const element = bodyRef.current;
    if (element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [card.answer, card.status]);

  function inspectSelection(body: HTMLDivElement) {
    const current = window.getSelection();
    const text = current?.toString().trim();
    if (!text || !current?.rangeCount || !body.contains(current.anchorNode)
      || !body.contains(current.focusNode) || card.status === "streaming") return;
    const range = current.getRangeAt(0).cloneRange();
    ask(card.id, () => range.startContainer.isConnected ? range.getBoundingClientRect() : undefined, text.slice(0, 50000));
  }

  return <div ref={bodyRef} className={expanded ? "card-body card-preview-body" : "card-body nodrag nowheel"}
    role={expanded ? "region" : undefined} aria-label={expanded ? "卡片内容" : undefined} tabIndex={expanded ? 0 : undefined}
    onScroll={(event) => {
      if (card.status !== "streaming") return;
      const target = event.currentTarget;
      stickToBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight <= 28;
    }}
    onMouseUp={(event) => {
      if (event.button === 0) inspectSelection(event.currentTarget);
    }} onKeyUp={(event) => {
      if (event.shiftKey && /^(Arrow|Home|End|Page)/.test(event.key)) inspectSelection(event.currentTarget);
    }}>
    <CardContent card={card} call={call} expanded={expanded} />
  </div>;
}

export function CardPreview({ card, bridge, close, children }: {
  card: Card; bridge: Bridge; close: () => void; children?: ReactNode;
}) {
  const [cited, setCited] = useState<CitedAnswer | null>(null);
  const [expandedIndex, setExpandedIndex] = useState<number>();
  const [citationError, setCitationError] = useState("");
  const active = useRef<{ prefix: string; index: number; trigger: HTMLButtonElement }>(undefined);
  const dismiss = useCallback((restoreFocus = false) => {
    const current = active.current;
    if (!current) return;
    active.current = undefined;
    setExpandedIndex(undefined);
    void bridge.call({ type: "closeAnswerCitation", prefix: current.prefix }).catch(() => undefined);
    if (restoreFocus) current.trigger.focus({ preventScroll: true });
  }, [bridge]);

  useEffect(() => {
    setCited(null);
    setCitationError("");
    if ((!card.importedTurn && !card.nativeBranch) || !card.answer || card.status === "streaming") return;
    let mounted = true;
    void bridge.call({ type: "readCitedAnswer", id: card.id }).then((answer) => {
      if (mounted) setCited(answer);
    }).catch(() => undefined);
    return () => {
      mounted = false;
      dismiss();
    };
  }, [bridge, card.answer, card.id, card.importedTurn, card.nativeBranch, card.status, dismiss]);

  useEffect(() => {
    if (!cited) return;
    const unsubscribe = bridge.subscribe((event) => {
      const current = active.current;
      if (event.type !== "citationClosed" || current?.prefix !== event.prefix || current.index !== event.index) return;
      active.current = undefined;
      setExpandedIndex(undefined);
      if (event.restoreFocus) current.trigger.focus({ preventScroll: true });
    });
    const clickOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest(".answer-citation"))) dismiss();
    };
    const scroll = () => dismiss();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !active.current) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss(true);
    };
    window.addEventListener("pointerdown", clickOutside, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      unsubscribe();
      window.removeEventListener("pointerdown", clickOutside, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [bridge, cited, dismiss]);

  function activate(index: number, trigger: HTMLButtonElement) {
    if (!cited) return;
    if (active.current?.index === index) return dismiss();
    const current = { prefix: cited.prefix, index, trigger };
    active.current = current;
    setExpandedIndex(index);
    setCitationError("");
    const { left, right, top, bottom } = trigger.getBoundingClientRect();
    void bridge.call({ type: "openAnswerCitation", prefix: cited.prefix, index, anchor: { left, right, top, bottom } })
      .catch((error) => {
        if (active.current !== current) return;
        dismiss();
        setCitationError(errorMessage(error));
      });
  }

  return <Dialog className="card-preview" title={kindLabels[card.kind]} close={close}>
    <answerCitations.Provider value={cited ? { cited, expandedIndex, activate } : undefined}>
      <SelectableCardBody card={card} expanded />
    </answerCitations.Provider>
    {citationError && <p className="muted citation-error" role="status">{citationError}</p>}
    {children}
  </Dialog>;
}

export function CardNode({ data: card }: NodeProps<FlowCard>) {
  const { ask, call, expand, lastMainId } = useContext(cardActions);
  const continuesMain = Boolean(lastMainId && card.id === lastMainId);
  const askLabel = continuesMain ? "继续对话" : "追问";

  return (
    <article className={`card card-${card.kind}`}>
      {card.parents.length > 0 && <Handle type="target" position={Position.Left} isConnectable={false} />}
      <Handle type="source" position={Position.Right} isConnectable={false} />
      {card.importedTurn && <>
        {card.parents.length > 0 && <Handle type="target" id="previous-turn" position={Position.Top} isConnectable={false} />}
        <Handle type="source" id="next-turn" position={Position.Bottom} isConnectable={false} />
      </>}
      <header className="card-head">
        <span className="card-grip" title="拖动卡片" aria-hidden="true"><GripHorizontal size={17} /></span>
        <div className="card-head-actions">
          {card.anchor && <button className="page-chip nodrag" onClick={() => void call({ type: "source", id: card.id })}>
            p. {card.anchor.page} <ArrowUpRight size={12} />
          </button>}
          {card.status === "streaming" && <span className="stream-dot" role="status" aria-label="生成中" title="生成中" />}
          <button className="icon-button card-expand nodrag" title="展开卡片" aria-label="展开卡片" aria-haspopup="dialog"
            onClick={(event) => { event.stopPropagation(); expand(card.id, event.currentTarget); }}><Maximize2 size={15} /></button>
        </div>
      </header>
      <h2>{card.title}</h2>
      <SelectableCardBody card={card} />
      <footer className={`card-foot${card.status !== "streaming" && !card.reference ? " card-foot-ask" : ""}`}>
        {card.status === "streaming" ?
          <button className="nodrag" onClick={() => void call({ type: "stop", id: card.id })}><Square size={13} />停止</button>
          : <button className="nodrag card-ask-button" title={askLabel} aria-label={askLabel} onClick={(event) => {
              const trigger = event.currentTarget;
              ask(card.id, () => trigger.isConnected ? trigger.getBoundingClientRect() : undefined, undefined, trigger);
            }}><Plus size={15} /></button>}
        {card.reference && <button className="nodrag" onClick={() => void call({ type: "source", id: card.id })}><ArrowUpRight size={14} />查看文献</button>}
      </footer>
      {!!card.sources?.length && <footer className="card-foot" style={{ flexWrap: "wrap" }}>
        {card.sources.map((anchor, index) => <button className="nodrag" key={anchor.uri} title={anchor.uri}
          onClick={() => void call({ type: "source", id: card.id, index })}><ArrowUpRight size={13} />PDF 第 {anchor.page} 页</button>)}
      </footer>}
    </article>
  );
}
