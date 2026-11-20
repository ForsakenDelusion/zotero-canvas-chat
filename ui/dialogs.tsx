import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowUpRight, BookMarked, Search, X } from "lucide-react";
import type { Reference, Settings, Snapshot } from "../shared/schema";
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

const endpoints: Record<Settings["provider"], string> = {
  compatible: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  ollama: "http://127.0.0.1:11434/v1",
  "llm-for-zotero": "",
};

export function SettingsDialog({ value, companionAvailable, close, save }: {
  value: Snapshot["settings"]; companionAvailable?: boolean; close: () => void; save: (settings: Settings, key?: string) => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings>(value);
  const [key, setKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const companion = settings.provider === "llm-for-zotero";
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError("");
    try { await save(settings, clearKey ? "" : key || undefined); close(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  return <Dialog title="模型设置" close={close}>
    <form onSubmit={(event) => void submit(event)}>
      <label>服务商<select value={settings.provider} onChange={(event) => {
        const provider = event.target.value as Settings["provider"];
        setSettings({ ...settings, provider, endpoint: endpoints[provider] });
        if (value.hasKey) setClearKey(true);
      }}>
        {(companionAvailable || companion) && <option value="llm-for-zotero">LLM for Zotero{companionAvailable ? "" : "（联动版未启用）"}</option>}
        <option value="compatible">OpenAI 兼容（含 OpenRouter）</option>
        <option value="anthropic">Anthropic</option>
        <option value="ollama">Ollama</option>
      </select></label>
      {companion ? <p className="muted field-note">画布联动需要 LLM for Zotero 的默认 API 模型。主对话使用 Antigravity 时，请在这里选择 API 服务商并配置画布模型。</p> : <>
      <label>服务地址<input value={settings.endpoint} required maxLength={2048}
        onChange={(event) => {
          setSettings({ ...settings, endpoint: event.target.value });
          if (value.hasKey) setClearKey(true);
        }} /></label>
      <label>模型名称<input value={settings.model} required maxLength={200}
        onChange={(event) => setSettings({ ...settings, model: event.target.value })} /></label>
      <label>API Key<input type="password" autoComplete="off" value={key} maxLength={5000}
        placeholder={value.hasKey && !clearKey ? "已保存，留空保留当前密钥" : "本地 Ollama 可留空"}
        onChange={(event) => { setKey(event.target.value); setClearKey(false); }} /></label>
      {value.hasKey && <label className="checkbox-line"><input type="checkbox" checked={clearKey}
        onChange={(event) => setClearKey(event.target.checked)} />清除已保存的密钥</label>}
      </>}
      <p className="muted field-note">提问时，选中路径的内容和论文摘要会发送到此模型服务。</p>
      {error && <p className="card-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="primary" disabled={pending}>保存设置</button></div>
    </form>
  </Dialog>;
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
