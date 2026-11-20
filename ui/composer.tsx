import { useLayoutEffect, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { useViewport } from "@xyflow/react";
import { ArrowUp, GitFork, LoaderCircle, MessageSquare, X } from "lucide-react";
import { questionSuggestions } from "../shared/question";

export type Composer = {
  parents: string[];
  quote?: string;
  anchor: () => DOMRect | undefined;
  trigger?: HTMLButtonElement;
};

export function QuestionComposer({ composer, source, mainConversation, blocked, draft, updateDraft, close, submit }: {
  composer: Composer;
  source?: string;
  mainConversation: boolean;
  blocked: boolean;
  draft: string;
  updateDraft: (prompt: string) => void;
  close: () => void;
  submit: (prompt: string) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState(draft);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const panel = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const viewport = useViewport();
  const isBranch = composer.parents.length > 0;
  const title = mainConversation ? "论文对话" : composer.parents.length > 1 ? "汇聚" : isBranch ? "追问" : "新建问题";
  const Icon = isBranch ? GitFork : MessageSquare;

  useLayoutEffect(() => {
    const form = panel.current!;
    function place() {
      const anchor = composer.anchor();
      const inset = 8;
      const gap = 6;
      const { width, height } = form.getBoundingClientRect();
      const limitX = Math.max(inset, innerWidth - width - inset);
      const limitY = Math.max(inset, innerHeight - height - inset);
      const visible = anchor && anchor.bottom >= 0 && anchor.top <= innerHeight && anchor.right >= 0 && anchor.left <= innerWidth;
      const left = visible ? Math.max(inset, Math.min(anchor.left, limitX)) : (innerWidth - width) / 2;
      const below = visible ? anchor.bottom + gap : limitY;
      const above = visible ? anchor.top - height - gap : inset;
      const top = below <= limitY ? below : above >= inset ? above : below;
      form.style.left = `${left}px`;
      form.style.top = `${Math.max(inset, Math.min(top, limitY))}px`;
    }
    place();
    const observer = new ResizeObserver(place);
    observer.observe(form);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [composer, viewport]);

  useEffect(() => {
    if (composer.trigger) input.current?.focus({ preventScroll: true });
  }, [composer]);

  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (pending || panel.current?.contains(event.target as Node) || composer.trigger?.contains(event.target as Node)) return;
      close();
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || pending) return;
      event.preventDefault();
      if (panel.current?.contains(document.activeElement)) composer.trigger?.focus({ preventScroll: true });
      close();
    }
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [close, composer.trigger, pending]);

  function edit(value: string) {
    setPrompt(value);
    updateDraft(value);
    setError("");
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim() || blocked || pending) return;
    setPending(true);
    setError("");
    try { await submit(prompt.trim()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }

  return createPortal(<form ref={panel} className="question-composer" aria-label={title} onSubmit={(event) => void send(event)}>
    <div className="question-context">
      <Icon size={14} aria-hidden="true" />
      <strong>{title}</strong>
      {source && <span title={source}>{source}</span>}
      <button className="icon-button question-close" type="button" aria-label="关闭提问" title="关闭" disabled={pending}
        onClick={() => { composer.trigger?.focus({ preventScroll: true }); close(); }}><X size={15} /></button>
    </div>
    {composer.quote && <blockquote className="question-quote">{composer.quote}</blockquote>}
    <textarea ref={input} aria-label="你的问题" value={prompt} maxLength={20000} rows={2} readOnly={pending}
      placeholder={mainConversation ? "问一个关于这篇论文的问题…" : isBranch ? "想进一步了解什么？" : "从一个问题开始…"}
      onChange={(event) => edit(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
          event.preventDefault();
          panel.current?.requestSubmit();
        }
      }} />
    {blocked && <p className="question-status" role="status">等来源卡片生成完毕后即可发送。</p>}
    {error && <p className="question-status card-error" role="alert">{error}</p>}
    <div className="question-actions">
      {isBranch && !prompt.trim() && !blocked && !pending && <div className="question-suggestions">
        {questionSuggestions.map(([label, suggestion]) => <button key={label} type="button" onClick={() => {
          edit(suggestion);
          input.current?.focus({ preventScroll: true });
        }}>{label}</button>)}
      </div>}
      <button className="icon-button question-send" type="submit" disabled={!prompt.trim() || blocked || pending}
        aria-label={mainConversation ? "发送到论文对话" : "发送问题"} title="发送（⌘/Ctrl + Enter）">
        {pending ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={17} />}
      </button>
    </div>
  </form>, document.body);
}
