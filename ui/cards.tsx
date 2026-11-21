import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ArrowDownRight, ArrowUpRight, BookMarked, Combine, FileText, GitFork, GripHorizontal, Maximize2, MessageSquare, RefreshCw, Square } from "lucide-react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { Card } from "../shared/schema";
import type { Bridge } from "./bridge";
import { Dialog } from "./dialogs";

const kinds = {
  excerpt: { label: "PDF 摘录", icon: FileText },
  branch: { label: "分支", icon: GitFork },
  synthesis: { label: "汇聚", icon: Combine },
  citation: { label: "文献引用", icon: BookMarked },
  response: { label: "论文对话", icon: MessageSquare },
};

export const cardActions = createContext<{
  call: Bridge["call"];
  ask(id: string, anchor: () => DOMRect | undefined, quote?: string, trigger?: HTMLButtonElement): void;
  expand(id: string, trigger: HTMLButtonElement): void;
}>(null!);
export type FlowCard = Node<Card, "card">;

function CardContent({ card, call, expanded = false }: { card: Card; call: Bridge["call"]; expanded?: boolean }) {
  const [image, setImage] = useState<string | null>();
  const question = card.kind !== "excerpt" && card.kind !== "citation";
  const answer = useMemo(() => card.answer && <div className="markdown">
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex, rehypeHighlight]}
      skipHtml
      disallowedElements={["img"]}
      components={{ a: ({ children }) => <span className="markdown-link">{children}</span> }}
    >{card.answer}</ReactMarkdown>
  </div>, [card.answer]);

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
    {expanded && card.status === "streaming" && <p className="muted" role="status">生成中…</p>}
    {card.status === "error" && <p className="card-error" role="alert">{card.error}</p>}
    {card.status === "stopped" && <p className="muted">生成已停止。</p>}
  </>;
}

function SelectableCardBody({ card, expanded = false }: { card: Card; expanded?: boolean }) {
  const { ask, call } = useContext(cardActions);

  function inspectSelection(body: HTMLDivElement) {
    const current = window.getSelection();
    const text = current?.toString().trim();
    if (!text || !current?.rangeCount || !body.contains(current.anchorNode)
      || !body.contains(current.focusNode) || card.status === "streaming") return;
    const range = current.getRangeAt(0).cloneRange();
    ask(card.id, () => range.startContainer.isConnected ? range.getBoundingClientRect() : undefined, text.slice(0, 50000));
  }

  return <div className={expanded ? "card-body card-preview-body" : "card-body nodrag nowheel"}
    role={expanded ? "region" : undefined} aria-label={expanded ? "卡片内容" : undefined} tabIndex={expanded ? 0 : undefined}
    onMouseUp={(event) => {
      if (event.button === 0) inspectSelection(event.currentTarget);
    }} onKeyUp={(event) => {
      if (event.shiftKey && /^(Arrow|Home|End|Page)/.test(event.key)) inspectSelection(event.currentTarget);
    }}>
    <CardContent card={card} call={call} expanded={expanded} />
  </div>;
}

export function CardPreview({ card, close, children }: { card: Card; close: () => void; children?: ReactNode }) {
  return <Dialog className="card-preview" title={kinds[card.kind].label} close={close}>
    <SelectableCardBody card={card} expanded />
    {children}
  </Dialog>;
}

export function CardNode({ data: card }: NodeProps<FlowCard>) {
  const { ask, call, expand } = useContext(cardActions);
  const { icon: Icon, label } = kinds[card.kind];

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
        <span className="card-kind"><Icon size={15} />{label}</span>
        <div className="card-head-actions">
          {card.anchor && <button className="page-chip nodrag" onClick={() => void call({ type: "source", id: card.id })}>
            p. {card.anchor.page} <ArrowUpRight size={12} />
          </button>}
          {card.status === "streaming" && <span className="stream-label"><i />生成中</span>}
          <button className="icon-button card-expand nodrag" title="展开卡片" aria-label="展开卡片" aria-haspopup="dialog"
            onClick={(event) => { event.stopPropagation(); expand(card.id, event.currentTarget); }}><Maximize2 size={15} /></button>
        </div>
      </header>
      <h2>{card.title}</h2>
      <SelectableCardBody card={card} />
      <footer className="card-foot">
        {card.status === "streaming" ?
          <button className="nodrag" onClick={() => void call({ type: "stop", id: card.id })}><Square size={13} />停止</button>
          : <>
            {!card.importedTurn && !card.nativeBranch && (card.status === "error" || card.status === "stopped") && <button className="nodrag" onClick={() => void call({ type: "retry", id: card.id })}><RefreshCw size={13} />重试</button>}
            <button className="nodrag" onClick={(event) => {
              const trigger = event.currentTarget;
              ask(card.id, () => trigger.isConnected ? trigger.getBoundingClientRect() : undefined, undefined, trigger);
            }}><ArrowDownRight size={14} />追问</button>
          </>}
        {card.reference && <button className="nodrag" onClick={() => void call({ type: "source", id: card.id })}><ArrowUpRight size={14} />查看文献</button>}
      </footer>
      {!!card.sources?.length && <footer className="card-foot" style={{ flexWrap: "wrap" }}>
        {card.sources.map((anchor, index) => <button className="nodrag" key={anchor.uri} title={anchor.uri}
          onClick={() => void call({ type: "source", id: card.id, index })}><ArrowUpRight size={13} />PDF 第 {anchor.page} 页</button>)}
      </footer>}
    </article>
  );
}
