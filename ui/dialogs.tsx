import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUpRight, BookMarked, Search, X } from "lucide-react";
import type { Reference } from "../shared/schema";
import type { Bridge } from "./bridge";

export function Dialog({ title, className, close, children }: {
  title: string; className?: string; close: () => void; children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  function dismiss() {
    dialog.current?.close();
    close();
  }
  return <dialog ref={dialog} className={className} onCancel={(event) => { event.preventDefault(); dismiss(); }} aria-label={title}>
    <header className="dialog-head"><h2>{title}</h2><button className="icon-button" title="关闭" onClick={dismiss}><X size={18} /></button></header>
    {children}
  </dialog>;
}

export function LibraryDialog({ call, close }: { call: Bridge["call"]; close: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Reference[]>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function search(event: FormEvent) {
    event.preventDefault();
    if (!query.trim()) return;
    setPending(true);
    setError("");
    try { setResults(await call({ type: "search", query: query.trim() })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  async function cite(uri: string) {
    setPending(true);
    try { await call({ type: "cite", uri }); close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setPending(false); }
  }
  return <Dialog title="引用本地文献" close={close}>
    <form className="search-form" onSubmit={(event) => void search(event)}>
      <input autoFocus placeholder="搜索标题、作者或年份" aria-label="搜索文库" value={query} maxLength={200} onChange={(event) => setQuery(event.target.value)} />
      <button className="primary" type="submit" disabled={pending || !query.trim()}><Search size={15} />搜索</button>
    </form>
    {error && <p className="card-error" role="alert">{error}</p>}
    {results?.length === 0 && <p className="muted">未找到匹配的文献。</p>}
    {results && <div className="search-results">{results.map((entry) =>
      <button className="reference-result" key={entry.uri} onClick={() => void cite(entry.uri)} disabled={pending}>
        <BookMarked size={17} /><span><strong>{entry.title}</strong><small>{[entry.authors, entry.year].filter(Boolean).join(" · ")}</small></span><ArrowUpRight size={16} />
      </button>)}</div>}
  </Dialog>;
}
