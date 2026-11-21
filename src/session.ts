import { ancestors, emptyDocument, messagesFor, nativeBranchContext, nextPosition, paperContext, type Message } from "../shared/graph";
import { nativeBranchPrompt } from "../shared/question";
import {
  defaultSettings, documentSchema, errorMessage, type Anchor, type CanvasDocument, type Card,
  type Command, type ConversationTurn, type Event, type Excerpt, type ImportedTurn, type Reference, type Settings, type Snapshot,
} from "../shared/schema";
import { modelEndpoint } from "./model";

export interface CanvasHost {
  paper: Reference;
  load(): Promise<CanvasDocument | null>;
  save(document: CanvasDocument): Promise<void>;
  getSettings(): Settings & { hasKey: boolean };
  companionAvailable?(): boolean;
  setSettings(settings: Settings, key?: string): void;
  generate(system: string, messages: Message[], signal: AbortSignal): AsyncIterable<string>;
  controller(): AbortController;
  image(anchor: Anchor): Promise<string | null>;
  open(uri: string): void;
  search(query: string): Promise<Reference[]>;
  reference(uri: string): Promise<Reference>;
  note(text: string, sources: { label: string; uri: string }[]): Promise<string>;
}

export class CanvasSession {
  private document = emptyDocument();
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly previous: Card[][] = [];
  private readonly next: Card[][] = [];
  private readonly jobs = new Map<string, AbortController>();
  private readonly nativeJobs = new Map<string, { stop: () => void; timeout: ReturnType<typeof setTimeout> }>();
  private readonly noteJobs = new Set<AbortController>();
  private readonly initialized: Promise<void>;
  private queue = Promise.resolve();
  private queuedSave?: ReturnType<typeof setTimeout>;
  private saved = true;
  private saveError?: string;
  private disposed = false;

  constructor(private readonly host: CanvasHost) {
    this.initialized = host.load().then((document) => {
      if (!document) return;
      this.document = documentSchema.parse(document);
      this.document.cards = this.document.cards.map((card) =>
        card.status === "streaming" ? { ...card, status: "stopped" } : card);
    });
    void this.initialized.catch(() => undefined);
  }

  subscribe(listener: (event: Event) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private snapshot(): Snapshot {
    return {
      document: this.document,
      paper: this.host.paper,
      undo: this.previous.length > 0 && this.jobs.size === 0 && this.nativeJobs.size === 0,
      redo: this.next.length > 0 && this.jobs.size === 0 && this.nativeJobs.size === 0,
      settings: this.host.getSettings(),
      companionAvailable: this.host.companionAvailable?.(),
      saved: this.saved,
      saveError: this.saveError,
    };
  }

  async ready() {
    await this.initialized;
    if (this.disposed) throw new Error("画布已关闭。");
    return this.snapshot();
  }

  private emit(event: Event = { type: "snapshot", snapshot: this.snapshot() }) {
    for (const listener of this.listeners) listener(event);
  }

  private serial<T>(action: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(() => this.initialized).then(action);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async save() {
    clearTimeout(this.queuedSave);
    this.queuedSave = undefined;
    const document = this.document;
    try {
      await this.host.save(document);
      this.saved = document === this.document;
      this.saveError = undefined;
    } catch (error) {
      this.saved = false;
      this.saveError = errorMessage(error).slice(0, 1000);
    }
    this.emit();
  }

  private scheduleSave() {
    if (!this.queuedSave) {
      this.queuedSave = setTimeout(() => {
        this.queuedSave = undefined;
        void this.serial(() => this.save()).catch(() => undefined);
      }, 700);
    }
  }

  private update(cards: Card[], record = true) {
    if (record) {
      this.previous.push(this.document.cards);
      if (this.previous.length > 25) this.previous.shift();
      this.next.length = 0;
    }
    this.document = { ...this.document, cards };
    this.saved = false;
    this.emit();
  }

  private getCard(id: string): Card {
    const card = this.document.cards.find((entry) => entry.id === id);
    if (!card) throw new Error("卡片已不存在。");
    return card;
  }

  private newCard(fields: Pick<Card, "kind" | "title"> & Partial<Card>, parents: Card[], existing = this.document.cards): Card {
    if (existing.length >= 1000) throw new Error("此画布已达到 1000 张卡片上限。");
    return {
      ...fields, ...nextPosition(existing, parents), id: globalThis.crypto.randomUUID(),
      parents: parents.map((card) => card.id),
    };
  }

  addExcerpt(excerpt: Excerpt, autoBranch: boolean) {
    return this.serial(async () => {
      const card = this.newCard({
        kind: "excerpt", title: excerpt.anchor.image ? "PDF 区域截图" : "PDF 原文摘录",
        anchor: excerpt.anchor, quote: excerpt.quote?.slice(0, 50000),
      }, []);
      const cards = [...this.document.cards, card];
      const child = autoBranch ? this.newCard({
        kind: "branch", title: "解释这段摘录", prompt: "解释这段摘录的核心意思、关键术语及它在论文中的作用。",
      }, [card], cards) : null;
      this.update(child ? [...cards, child] : cards);
      this.emit({ type: "focus", id: card.id });
      if (child) this.start(child);
      await this.save();
    });
  }

  importTurn(turn: ImportedTurn) {
    return this.serial(async () => {
      if (this.disposed) throw new Error("画布已关闭。");
      let card = this.document.cards.find((entry) => entry.importedTurn === turn.id);
      if (!card) {
        card = this.newCard({
          kind: "response", importedTurn: turn.id, title: turn.prompt.slice(0, 80),
          prompt: turn.prompt, answer: turn.answer, sources: turn.sources, status: "done",
        }, []);
        this.update([...this.document.cards, card]);
      }
      this.emit({ type: "focus", id: card.id });
      if (!this.saved) await this.save();
      if (this.saveError) throw new Error(this.saveError);
    });
  }

  syncConversation(turns: ConversationTurn[], partial = false) {
    return this.serial(() => {
      if (this.disposed || !turns.length) return;
      const nativeBranches = new Map(this.document.cards.filter((card) => card.nativeBranch).map((card) => [card.id, card]));
      for (const turn of turns) {
        const branch = turn.branchID && nativeBranches.get(turn.branchID);
        if (!branch) continue;
        const status = turn.stopped ? "stopped" : "done";
        const nativeBranch = Number(turn.id.split(":", 1)[0]) || branch.nativeBranch;
        if (branch.answer === turn.answer && branch.status === status && branch.nativeBranch === nativeBranch &&
            branch.prompt === turn.prompt &&
            JSON.stringify(branch.sources ?? []) === JSON.stringify(turn.sources)) continue;
        this.finishNativeBranch(branch.id, {
          title: turn.prompt.slice(0, 80), prompt: turn.prompt, answer: turn.answer,
          sources: turn.sources, status, nativeBranch,
        });
      }
      if (partial) return;
      const existing = this.document.cards;
      const byTurn = new Map(existing.filter((card) => card.importedTurn).map((card) => [card.importedTurn, card]));
      const responses = turns.filter((turn) => !turn.branchID || !nativeBranches.has(turn.branchID));
      const firstNewResponse = responses[responses.findLastIndex((turn) => byTurn.has(turn.id)) + 1];
      const synced: Card[] = [];
      const added: Card[] = [];
      for (const turn of responses) {
        const previous = synced.at(-1);
        const current = byTurn.get(turn.id) ??
          (turn === firstNewResponse ? replacedResponse(byTurn.values(), turn, previous) : undefined);
        if (!current && existing.length + added.length >= 1000) continue;
        const position = current ?? (previous
          ? { x: previous.x, y: previous.y + 420 }
          : nextPosition(existing, []));
        let { x, y } = position;
        while (!current && (existing.some(overlaps) || added.some(overlaps))) y += 420;
        function overlaps(card: Card) {
          return Math.abs(card.x - x) < 360 && Math.abs(card.y - y) < 400;
        }
        const updated: Card = {
          id: current?.id ?? `llm:${turn.id}`,
          x, y, kind: "response", importedTurn: turn.id, messageIndex: turn.messageIndex,
          parents: previous ? [previous.id] : [],
          title: turn.prompt.slice(0, 80), prompt: turn.prompt, answer: turn.answer,
          sources: turn.sources.length || current?.importedTurn !== turn.id ? turn.sources : current.sources ?? [],
          status: turn.stopped ? "stopped" : "done",
        };
        if (!current) added.push(updated);
        synced.push(current && JSON.stringify(current) === JSON.stringify(updated) ? current : updated);
      }
      if (synced.every((card) => byTurn.get(card.importedTurn) === card)) return;
      const apply = (cards: Card[]) => {
        const byId = new Map(cards.map((card) => [card.id, card]));
        for (const card of synced) {
          const old = byId.get(card.id);
          byId.set(card.id, old ? { ...card, x: old.x, y: old.y } : card);
        }
        const ordered: Card[] = [];
        const append = (card: Card) => {
          if (!byId.delete(card.id)) return;
          for (const id of card.parents) {
            const parent = byId.get(id);
            if (parent) append(parent);
          }
          ordered.push(card);
        };
        for (const card of byId.values()) append(card);
        return ordered;
      };
      for (const history of [this.previous, this.next]) {
        for (let index = 0; index < history.length; index++) {
          const cards = apply(history[index]);
          history[index] = cards.length > 1000 ? this.document.cards : cards;
        }
      }
      this.update(apply(existing), false);
      this.scheduleSave();
    });
  }

  submitNativeBranch(
    ids: string[], prompt: string, quote: string | undefined, conversationKey: number,
    send: (text: string, images: string[]) => Promise<void>, stop: () => void,
  ) {
    return this.serial(async () => {
      if (this.disposed) throw new Error("画布已关闭。");
      const parents = [...new Set(ids)].map((id) => this.getCard(id));
      const path = ancestors(this.document, parents.map((parent) => parent.id));
      if (path.some((card) => card.status === "streaming")) throw new Error("请等上游卡片生成完毕。");
      const card = this.newCard({
        kind: parents.length > 1 ? "synthesis" : "branch", title: prompt.slice(0, 80),
        prompt, quote, nativeBranch: conversationKey, status: "streaming",
      }, parents);
      const context = await nativeBranchContext(path, parents, quote, (anchor) => this.host.image(anchor));
      await send(nativeBranchPrompt(card.id, prompt, context.text), context.images);
      const timeout = setTimeout(() => {
        void this.serial(() => this.finishNativeBranch(card.id, { status: "stopped" })).catch(() => undefined);
      }, 300_000);
      this.nativeJobs.set(card.id, { stop, timeout });
      this.update([...this.document.cards, card]);
      this.emit({ type: "focus", id: card.id });
      this.scheduleSave();
    });
  }

  private finishNativeBranch(id: string, changes: Partial<Card>) {
    const job = this.nativeJobs.get(id);
    if (job) clearTimeout(job.timeout);
    this.nativeJobs.delete(id);
    this.patch(id, changes);
    this.emit();
    this.scheduleSave();
  }

  private patch(id: string, changes: Partial<Card>) {
    const card = this.document.cards.find((entry) => entry.id === id);
    if (!card) return;
    const patched = { ...card, ...changes };
    const replace = (cards: Card[]) => cards.map((entry) => entry.id === id ? { ...entry, ...changes } : entry);
    this.document = { ...this.document, cards: replace(this.document.cards) };
    for (const history of [this.previous, this.next]) {
      for (let index = 0; index < history.length; index++) history[index] = replace(history[index]);
    }
    this.saved = false;
    this.emit({ type: "card", card: patched });
  }

  private async run(card: Card, path: Card[], controller: AbortController) {
    let answer = "";
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      const messages = await messagesFor(path, card.prompt!, card.quote, (anchor) => this.host.image(anchor),
        path.some((entry) => entry.parents.length > 1) || card.kind === "synthesis");
      for await (const chunk of this.host.generate(paperContext(this.host.paper), messages, controller.signal)) {
        if (controller.signal.aborted) break;
        answer = (answer + chunk).slice(0, 65000);
        this.patch(card.id, { answer });
        this.scheduleSave();
        if (answer.length === 65000) break;
      }
      if (controller.signal.aborted) this.patch(card.id, { status: "stopped" });
      else if (answer.trim()) this.patch(card.id, { status: "done" });
      else throw new Error("模型未返回文本，请重试。");
    } catch (error) {
      this.patch(card.id, controller.signal.aborted
        ? { status: "stopped" }
        : { status: "error", error: errorMessage(error).slice(0, 1000) });
    } finally {
      clearTimeout(timeout);
      this.jobs.delete(card.id);
      if (!this.disposed) await this.serial(() => this.save());
    }
  }

  private start(card: Card) {
    if (!card.prompt || this.jobs.has(card.id)) return;
    const path = ancestors(this.document, card.parents);
    const controller = this.host.controller();
    this.jobs.set(card.id, controller);
    this.patch(card.id, { status: "streaming", answer: "", error: undefined });
    this.emit();
    void this.run(card, path, controller).catch(() => undefined);
  }

  async command(command: Command): Promise<unknown> {
    await this.initialized;
    if (this.disposed) throw new Error("画布已关闭。");
    switch (command.type) {
      case "ready": return this.snapshot();
      case "search": return this.host.search(command.query);
      case "source": {
        const card = this.getCard(command.id);
        const uri = command.index === undefined ? card.anchor?.uri ?? card.reference?.uri : card.sources?.[command.index]?.uri;
        if (uri) this.host.open(uri);
        return;
      }
      case "image": {
        const anchor = this.getCard(command.id).anchor;
        return anchor?.image ? this.host.image(anchor) : null;
      }
      case "crystallize": {
        const path = ancestors(this.document, command.ids);
        if (path.some((card) => card.status === "streaming")) throw new Error("请等选中路径生成完毕。");
        const messages = await messagesFor(path,
          "把上述阅读记录整理为中文笔记。用 Markdown 标题和列表梳理问题、结论、证据和待验证事项。", undefined,
          (anchor) => this.host.image(anchor), true);
        const controller = this.host.controller();
        this.noteJobs.add(controller);
        const timeout = setTimeout(() => controller.abort(), 180_000);
        try {
          let text = "";
          for await (const chunk of this.host.generate(paperContext(this.host.paper), messages, controller.signal)) {
            text = (text + chunk).slice(0, 65000);
            if (text.length === 65000) break;
          }
          if (controller.signal.aborted || this.disposed) throw new Error("笔记生成已停止。");
          if (!text.trim()) throw new Error("模型未生成笔记正文。");
          const sources = new Map<string, string>();
          for (const card of path) {
            if (card.anchor) sources.set(card.anchor.uri, `PDF 第 ${card.anchor.page} 页`);
            for (const anchor of card.sources ?? []) sources.set(anchor.uri, `PDF 第 ${anchor.page} 页`);
            if (card.reference) sources.set(card.reference.uri, card.reference.title);
          }
          return await this.host.note(text, [...sources].map(([uri, label]) => ({ uri, label })));
        } finally {
          clearTimeout(timeout);
          this.noteJobs.delete(controller);
        }
      }
    }
    return this.serial(async () => {
      if (this.disposed) throw new Error("画布已关闭。");
      switch (command.type) {
        case "branch": {
          const parents = [...new Set(command.parents)].map((id) => this.getCard(id));
          if (ancestors(this.document, parents.map((parent) => parent.id)).some((card) => card.status === "streaming")) {
            throw new Error("请等上游卡片生成完毕。");
          }
          const card = this.newCard({
            kind: parents.length > 1 ? "synthesis" : "branch",
            title: command.prompt.slice(0, 80), prompt: command.prompt, quote: command.quote,
          }, parents);
          this.update([...this.document.cards, card]);
          this.start(card);
          this.emit({ type: "focus", id: card.id });
          await this.save();
          return card.id;
        }
        case "move": {
          const positions = new Map(command.positions.map(({ id, ...position }) => [id, position]));
          this.update(this.document.cards.map((card) => ({ ...card, ...positions.get(card.id) })));
          break;
        }
        case "viewport":
          this.document = { ...this.document, viewport: command.viewport };
          if (this.document.cards.length) this.scheduleSave();
          return;
        case "remove": {
          const ids = new Set(command.ids);
          if (this.document.cards.some((card) => ids.has(card.id) && card.importedTurn)) {
            throw new Error("请在论文对话中移除这条消息。");
          }
          for (const card of this.document.cards) if (card.parents.some((parent) => ids.has(parent))) ids.add(card.id);
          for (const id of ids) {
            this.jobs.get(id)?.abort();
            const native = this.nativeJobs.get(id);
            if (native) {
              native.stop();
              clearTimeout(native.timeout);
              this.nativeJobs.delete(id);
            }
          }
          this.update(this.document.cards.filter((card) => !ids.has(card.id)));
          break;
        }
        case "undo":
        case "redo": {
          if (this.jobs.size || this.nativeJobs.size) return;
          const from = command.type === "undo" ? this.previous : this.next;
          const to = command.type === "undo" ? this.next : this.previous;
          const cards = from.pop();
          if (!cards) return;
          to.push(this.document.cards);
          this.update(cards, false);
          break;
        }
        case "retry": {
          const card = this.getCard(command.id);
          if (card.importedTurn) throw new Error("请在论文对话中重试这条消息。");
          this.start(card);
          break;
        }
        case "stop":
          this.jobs.get(command.id)?.abort();
          this.nativeJobs.get(command.id)?.stop();
          return;
        case "cite": {
          const reference = await this.host.reference(command.uri);
          const card = this.newCard({ kind: "citation", title: reference.title.slice(0, 500), reference }, []);
          this.update([...this.document.cards, card]);
          this.emit({ type: "focus", id: card.id });
          break;
        }
        case "settings": {
          if (command.settings.provider === "llm-for-zotero") {
            if (!this.host.companionAvailable?.()) throw new Error("请安装支持画布的 LLM for Zotero 联动版。");
            this.host.setSettings(command.settings);
            this.emit();
            return;
          }
          const endpoint = modelEndpoint(command.settings);
          const current = this.host.getSettings();
          let changed = current.provider !== command.settings.provider;
          if (!changed) {
            try { changed = modelEndpoint(current) !== endpoint; }
            catch { changed = true; }
          }
          this.host.setSettings(command.settings, command.key ?? (changed ? "" : undefined));
          this.emit();
          return;
        }
        case "save": break;
      }
      await this.save();
    });
  }

  async close() {
    this.disposed = true;
    for (const controller of this.jobs.values()) controller.abort();
    for (const controller of this.noteJobs) controller.abort();
    for (const job of this.nativeJobs.values()) clearTimeout(job.timeout);
    this.nativeJobs.clear();
    this.listeners.clear();
    clearTimeout(this.queuedSave);
    if (!this.saved) await this.serial(() => this.save());
  }
}

function replacedResponse(cards: Iterable<Card>, turn: ConversationTurn, previous?: Card) {
  if (turn.messageIndex === undefined) return;
  const [key, timestamp] = turn.id.split(":");
  const previousTimestamp = Number(previous?.importedTurn?.split(":")[1] ?? 0);
  const candidates = [...cards].filter((card) => {
    const [oldKey, oldTimestamp] = card.importedTurn!.split(":");
    return oldKey === key && Number(oldTimestamp) > previousTimestamp && Number(oldTimestamp) < Number(timestamp) &&
      (previous ? card.parents.length === 1 && card.parents[0] === previous.id : card.parents.length === 0);
  });
  const indexed = candidates.filter((card) => card.messageIndex === turn.messageIndex);
  const legacy = candidates.filter((card) => card.messageIndex === undefined);
  if (indexed.length === 1) return indexed[0];
  if (!indexed.length && legacy.length === 1) return legacy[0];
}

export const initialSettings = () => ({ ...defaultSettings, hasKey: false });
