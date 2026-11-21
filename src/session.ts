import { ancestors, emptyDocument, nativeBranchContext, nextPosition, type NativeBranchContext } from "../shared/graph";
import {
  documentSchema, errorMessage, type Anchor, type CanvasDocument, type Card,
  type Command, type ConversationTurn, type Event, type Excerpt, type Reference, type Snapshot,
} from "../shared/schema";

export type NativeBranchSubmission = NativeBranchContext & { prompt: string };

export interface CanvasHost {
  paper: Reference;
  load(): Promise<CanvasDocument | null>;
  save(document: CanvasDocument): Promise<void>;
  image(anchor: Anchor): Promise<string | null>;
  open(uri: string): void;
  search(query: string): Promise<Reference[]>;
  reference(uri: string): Promise<Reference>;
  note(text: string, sources: { label: string; uri: string }[]): Promise<string>;
}

type HistoryEntry = { cards: Card[]; hiddenTurns: string[] };
type PendingHiddenBranch = {
  id: string;
  conversationKey: number;
  messageIndex?: number;
  prompt?: string;
};

export class CanvasSession {
  private document = emptyDocument();
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly previous: HistoryEntry[] = [];
  private readonly next: HistoryEntry[] = [];
  private readonly pendingHidden = new Map<string, PendingHiddenBranch>();
  private readonly nativeJobs = new Map<string, { stop: () => void; timeout: ReturnType<typeof setTimeout> }>();
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
      undo: this.previous.length > 0 && this.nativeJobs.size === 0,
      redo: this.next.length > 0 && this.nativeJobs.size === 0,
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

  private update(cards: Card[], record = true, hiddenTurns: string[] = this.document.hiddenTurns ?? []) {
    if (record) {
      this.previous.push({ cards: this.document.cards, hiddenTurns: this.document.hiddenTurns ?? [] });
      if (this.previous.length > 25) this.previous.shift();
      this.next.length = 0;
    }
    this.document = { ...this.document, cards, hiddenTurns: hiddenTurns.length ? hiddenTurns : undefined };
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

  addExcerpt(excerpt: Excerpt) {
    return this.serial(async () => {
      const card = this.newCard({
        kind: "excerpt", title: excerpt.anchor.image ? "PDF 区域截图" : "PDF 原文摘录",
        anchor: excerpt.anchor, quote: excerpt.quote?.slice(0, 50000),
      }, []);
      this.update([...this.document.cards, card]);
      this.emit({ type: "focus", id: card.id });
      await this.save();
    });
  }

  syncConversation(turns: ConversationTurn[], partial = false) {
    return this.serial(() => {
      if (this.disposed || !turns.length) return;
      const existing = this.document.cards;
      const existingIDs = new Set(existing.map((card) => card.id));
      for (const id of [...this.pendingHidden.keys()]) {
        if (existingIDs.has(id)) this.pendingHidden.delete(id);
      }
      const hidden = new Set(this.document.hiddenTurns ?? []);
      let promotedHidden = false;
      const visibleTurns: ConversationTurn[] = [];
      for (const turn of turns) {
        if (hidden.has(turn.id)) continue;
        const pending = matchPendingHidden(this.pendingHidden, turn);
        if (pending) {
          this.pendingHidden.delete(pending.id);
          hidden.add(turn.id);
          promotedHidden = true;
          for (const history of [this.previous, this.next]) {
            for (let index = 0; index < history.length; index++) {
              const entry = history[index];
              if (entry.cards.some((card) => card.id === pending.id)) continue;
              const nextHidden = new Set(entry.hiddenTurns ?? []);
              nextHidden.add(turn.id);
              history[index] = { ...entry, hiddenTurns: [...nextHidden].slice(-1000) };
            }
          }
          continue;
        }
        visibleTurns.push(turn);
      }
      if (promotedHidden) {
        this.document = { ...this.document, hiddenTurns: [...hidden].slice(-1000) };
        this.saved = false;
        this.emit();
        this.scheduleSave();
      }
      if (!visibleTurns.length) return;
      const byTurn = new Map(existing.filter((card) => card.importedTurn).map((card) => [card.importedTurn!, card]));
      const nativeBranchCards = existing.filter((card) => card.nativeBranch);
      const byBranchID = new Map(nativeBranchCards.map((card) => [card.id, card]));
      const byNativeTurn = new Map(nativeBranchCards.filter((card) => card.nativeTurn).map((card) => [card.nativeTurn!, card]));
      const activeTurnIDs = new Set(turns.map((turn) => turn.id));
      const claimedTurnIDs = new Set<string>();
      const matchedBranchIDs = new Set<string>();

      const matchBranch = (turn: ConversationTurn): Card | undefined => {
        if (turn.branchID) {
          const legacy = byBranchID.get(turn.branchID);
          if (legacy && !matchedBranchIDs.has(legacy.id)) return legacy;
        }
        const bound = byNativeTurn.get(turn.id);
        if (bound && !matchedBranchIDs.has(bound.id)) return bound;
        if (byTurn.has(turn.id)) return undefined;
        const key = Number(turn.id.split(":", 1)[0]);
        if (!key) return undefined;
        const pending = nativeBranchCards.filter((card) =>
          card.nativeBranch === key && !card.nativeTurn && card.status === "streaming" && !matchedBranchIDs.has(card.id));
        if (pending.length) {
          const byIndex = turn.messageIndex !== undefined
            ? pending.filter((card) => card.messageIndex === turn.messageIndex)
            : [];
          if (byIndex.length === 1) return byIndex[0];
          if (!byIndex.length) {
            const byPrompt = pending.filter((card) => card.prompt === turn.prompt);
            if (byPrompt.length === 1) return byPrompt[0];
          }
        }
        return replacedNativeBranch(nativeBranchCards, turn, activeTurnIDs, matchedBranchIDs);
      };

      for (const turn of visibleTurns) {
        const branch = matchBranch(turn);
        if (!branch) continue;
        claimedTurnIDs.add(turn.id);
        matchedBranchIDs.add(branch.id);
        const status = turn.stopped ? "stopped" : "done";
        const nativeBranch = Number(turn.id.split(":", 1)[0]) || branch.nativeBranch;
        const messageIndex = turn.messageIndex ?? branch.messageIndex;
        if (branch.answer === turn.answer && branch.status === status && branch.nativeBranch === nativeBranch &&
            branch.nativeTurn === turn.id && branch.messageIndex === messageIndex &&
            branch.prompt === turn.prompt &&
            JSON.stringify(branch.sources ?? []) === JSON.stringify(turn.sources)) continue;
        this.finishNativeBranch(branch.id, {
          title: turn.prompt.slice(0, 80), prompt: turn.prompt, answer: turn.answer,
          sources: turn.sources, status, nativeBranch, nativeTurn: turn.id, messageIndex,
        });
      }
      if (partial) return;
      const latest = this.document.cards;
      const latestByTurn = new Map(latest.filter((card) => card.importedTurn).map((card) => [card.importedTurn!, card]));
      const unclaimed = visibleTurns.filter((turn) => !claimedTurnIDs.has(turn.id));
      const lastExistingIndex = unclaimed.findLastIndex((turn) => latestByTurn.has(turn.id));
      let usedReplacement = false;
      const synced: Card[] = [];
      const syncedMain: Card[] = [];
      const added: Card[] = [];
      const conversationKey = Number(visibleTurns[0]?.id.split(":", 1)[0]) || 0;
      const branchPool = latest.filter((card) =>
        card.nativeBranch === conversationKey && card.nativeTurn && activeTurnIDs.has(card.nativeTurn));
      for (const [unclaimedIndex, turn] of unclaimed.entries()) {
        const previous = syncedMain.at(-1);
        const existingMain = latestByTurn.get(turn.id);
        if (!existingMain && turn.quotedTexts?.length && conversationKey) {
          const candidates = [...branchPool, ...syncedMain, ...added].filter((card) =>
            card.answer && (turn.messageIndex === undefined || card.messageIndex === undefined || card.messageIndex < turn.messageIndex));
          const quotedParents = findQuotedParents(candidates, turn.quotedTexts);
          if (quotedParents.length) {
            if (latest.length + added.length >= 1000) continue;
            const branchCard: Card = {
              id: `llm:${turn.id}`,
              ...nextPosition([...latest, ...added], quotedParents),
              kind: quotedParents.length > 1 ? "synthesis" : "branch",
              nativeBranch: conversationKey,
              nativeTurn: turn.id,
              messageIndex: turn.messageIndex,
              parents: quotedParents.map((parent) => parent.id),
              quote: turn.quotedTexts.join("\n\n").slice(0, 50000),
              title: turn.prompt.slice(0, 80),
              prompt: turn.prompt,
              answer: turn.answer,
              sources: turn.sources,
              status: turn.stopped ? "stopped" : "done",
            };
            added.push(branchCard);
            synced.push(branchCard);
            continue;
          }
        }
        let current = existingMain;
        if (!current && unclaimedIndex > lastExistingIndex && !usedReplacement) {
          usedReplacement = true;
          current = replacedResponse(latestByTurn.values(), turn, previous);
        }
        if (!current && latest.length + added.length >= 1000) continue;
        const position = current ?? (previous
          ? { x: previous.x, y: previous.y + 420 }
          : nextPosition(latest, []));
        let { x, y } = position;
        while (!current && (latest.some(overlaps) || added.some(overlaps))) y += 420;
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
        const resolved = current && JSON.stringify(current) === JSON.stringify(updated) ? current : updated;
        synced.push(resolved);
        syncedMain.push(resolved);
      }
      if (synced.every((card) => card.importedTurn && latestByTurn.get(card.importedTurn) === card)) return;
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
          const cards = apply(history[index].cards);
          history[index] = { ...history[index], cards: cards.length > 1000 ? this.document.cards : cards };
        }
      }
      this.update(apply(latest), false);
      this.scheduleSave();
    });
  }

  submitNativeBranch(
    ids: string[], prompt: string, quote: string | undefined, conversationKey: number,
    send: (payload: NativeBranchSubmission) => Promise<{ messageIndex?: number } | void>, stop: () => void,
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
      const context = await nativeBranchContext(path, parents, quote, (anchor) => this.host.image(anchor), conversationKey);
      const sent = await send({ prompt, ...context });
      const created = sent?.messageIndex !== undefined ? { ...card, messageIndex: sent.messageIndex } : card;
      const timeout = setTimeout(() => {
        void this.serial(() => this.finishNativeBranch(created.id, { status: "stopped" })).catch(() => undefined);
      }, 300_000);
      this.nativeJobs.set(created.id, { stop, timeout });
      this.update([...this.document.cards, created]);
      this.emit({ type: "focus", id: created.id });
      this.scheduleSave();
      return created.id;
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
      for (let index = 0; index < history.length; index++) {
        history[index] = { ...history[index], cards: replace(history[index].cards) };
      }
    }
    this.saved = false;
    this.emit({ type: "card", card: patched });
  }

  async crystallize(
    ids: string[],
    conversationKey: number,
    send: (
      payload: NativeBranchSubmission,
      onSent: (info: { messageIndex?: number }) => void,
    ) => Promise<string>,
  ): Promise<string> {
    const { payload, sources } = await this.serial(async () => {
      if (this.disposed) throw new Error("画布已关闭。");
      const parents = [...new Set(ids)].map((id) => this.getCard(id));
      const path = ancestors(this.document, parents.map((parent) => parent.id));
      if (path.some((card) => card.status === "streaming")) throw new Error("请等选中路径生成完毕。");
      const prompt = "把上述阅读记录整理为中文笔记。用 Markdown 标题和列表梳理问题、结论、证据和待验证事项。";
      const context = await nativeBranchContext(path, parents, undefined, (anchor) => this.host.image(anchor), conversationKey);
      const collected = new Map<string, string>();
      for (const card of path) {
        if (card.anchor) collected.set(card.anchor.uri, `PDF 第 ${card.anchor.page} 页`);
        for (const anchor of card.sources ?? []) collected.set(anchor.uri, `PDF 第 ${anchor.page} 页`);
        if (card.reference) collected.set(card.reference.uri, card.reference.title);
      }
      return {
        payload: { prompt, ...context },
        sources: [...collected].map(([uri, label]) => ({ uri, label })),
      };
    });
    const text = await send(payload, ({ messageIndex }) => {
      if (!conversationKey) return;
      const pendingId = `note:${globalThis.crypto.randomUUID()}`;
      this.pendingHidden.set(pendingId, {
        id: pendingId,
        conversationKey,
        messageIndex,
        prompt: payload.prompt,
      });
    });
    if (this.disposed) throw new Error("画布已关闭。");
    if (!text.trim()) throw new Error("模型未生成笔记正文。");
    return await this.host.note(text, sources);
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
      case "crystallize":
        throw new Error("请在 LLM for Zotero 中生成阅读笔记。");
    }
    return this.serial(async () => {
      if (this.disposed) throw new Error("画布已关闭。");
      switch (command.type) {
        case "move": {
          const positions = new Map(command.positions.map(({ id, ...position }) => [id, position]));
          this.update(this.document.cards.map((card) => ({ ...card, ...positions.get(card.id) })));
          break;
        }
        case "viewport":
          this.document = { ...this.document, viewport: command.viewport };
          if (this.document.cards.length || this.document.hiddenTurns?.length) this.scheduleSave();
          return;
        case "remove": {
          const ids = new Set(command.ids);
          for (const card of this.document.cards) if (card.parents.some((parent) => ids.has(parent))) ids.add(card.id);
          if (this.document.cards.some((card) => ids.has(card.id) && card.importedTurn)) {
            throw new Error("请在论文对话中移除这条消息。");
          }
          const removed = this.document.cards.filter((card) => ids.has(card.id));
          const nextHidden = new Set(this.document.hiddenTurns ?? []);
          for (const card of removed) {
            if (card.nativeTurn) nextHidden.add(card.nativeTurn);
            else if (card.nativeBranch) {
              this.pendingHidden.set(card.id, {
                id: card.id,
                conversationKey: card.nativeBranch,
                messageIndex: card.messageIndex,
                prompt: card.prompt,
              });
            }
          }
          for (const id of ids) {
            const native = this.nativeJobs.get(id);
            if (native) {
              native.stop();
              clearTimeout(native.timeout);
              this.nativeJobs.delete(id);
            }
          }
          const hiddenTurns = [...nextHidden].slice(-1000);
          this.update(this.document.cards.filter((card) => !ids.has(card.id)), true, hiddenTurns);
          break;
        }
        case "undo":
        case "redo": {
          if (this.nativeJobs.size) return;
          const from = command.type === "undo" ? this.previous : this.next;
          const to = command.type === "undo" ? this.next : this.previous;
          const entry = from.pop();
          if (!entry) return;
          to.push({ cards: this.document.cards, hiddenTurns: this.document.hiddenTurns ?? [] });
          this.update(entry.cards, false, entry.hiddenTurns);
          break;
        }
        case "stop":
          this.nativeJobs.get(command.id)?.stop();
          return;
        case "cite": {
          const reference = await this.host.reference(command.uri);
          const card = this.newCard({ kind: "citation", title: reference.title.slice(0, 500), reference }, []);
          this.update([...this.document.cards, card]);
          this.emit({ type: "focus", id: card.id });
          break;
        }
        case "save": break;
      }
      await this.save();
    });
  }

  async close() {
    this.disposed = true;
    for (const job of this.nativeJobs.values()) clearTimeout(job.timeout);
    this.nativeJobs.clear();
    this.listeners.clear();
    clearTimeout(this.queuedSave);
    if (!this.saved) await this.serial(() => this.save());
  }
}

function matchPendingHidden(
  pendingHidden: ReadonlyMap<string, PendingHiddenBranch>, turn: ConversationTurn,
): PendingHiddenBranch | undefined {
  if (!pendingHidden.size) return;
  if (turn.branchID) {
    const legacy = pendingHidden.get(turn.branchID);
    if (legacy) return legacy;
  }
  const key = Number(turn.id.split(":", 1)[0]);
  if (!key) return;
  const sameConv = [...pendingHidden.values()].filter((entry) => entry.conversationKey === key);
  if (!sameConv.length) return;
  if (turn.messageIndex !== undefined) {
    const byIndex = sameConv.filter((entry) => entry.messageIndex === turn.messageIndex);
    if (byIndex.length === 1) return byIndex[0];
  }
  const byPrompt = sameConv.filter((entry) => entry.messageIndex === undefined && entry.prompt === turn.prompt);
  if (byPrompt.length === 1) return byPrompt[0];
}

function quoteCore(text: string) {
  return text.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

function answerMatchesQuote(answer: string, quote: string) {
  const cleanQuote = quote.replace(/\s+/g, " ").trim();
  if (cleanQuote.length >= 4 && answer.replace(/\s+/g, " ").includes(cleanQuote)) return true;
  const needle = quoteCore(quote);
  if (needle.length < 6) return false;
  const haystack = quoteCore(answer);
  if (haystack.includes(needle)) return true;
  if (needle.length >= 30) {
    const start = haystack.indexOf(needle.slice(0, 16));
    if (start >= 0 && haystack.indexOf(needle.slice(-16), start + 16) >= 0) return true;
  }
  return false;
}

function findQuotedParents(candidates: Card[], quotedTexts: string[]) {
  const ordered = [...candidates].sort((a, b) => (b.messageIndex ?? -1) - (a.messageIndex ?? -1));
  const matched = new Map<string, Card>();
  for (const quote of quotedTexts) {
    const parent = ordered.find((card) => card.answer && answerMatchesQuote(card.answer, quote));
    if (parent) matched.set(parent.id, parent);
  }
  return [...matched.values()];
}

function replacedNativeBranch(
  cards: Card[], turn: ConversationTurn, activeTurnIDs: ReadonlySet<string>, matchedBranchIDs: ReadonlySet<string>,
) {
  if (turn.messageIndex === undefined) return;
  const [key, timestamp] = turn.id.split(":");
  const keyNumber = Number(key);
  const candidates = cards.filter((card) => {
    if (matchedBranchIDs.has(card.id) || card.nativeBranch !== keyNumber ||
        !card.nativeTurn || activeTurnIDs.has(card.nativeTurn) ||
        card.messageIndex !== turn.messageIndex) return false;
    const [oldKey, oldTimestamp] = card.nativeTurn.split(":");
    return oldKey === key && Number(oldTimestamp) < Number(timestamp);
  });
  if (candidates.length === 1) return candidates[0];
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
