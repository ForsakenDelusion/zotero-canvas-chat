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
type LiveCard = {
  conversationKey: number;
  messageIndex?: number;
  turnID: string;
  targetID?: string;
  card: Card;
};
export type SyncOutcome = "none" | "card" | "snapshot";

export class CanvasSession {
  private document = emptyDocument();
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly previous: HistoryEntry[] = [];
  private readonly next: HistoryEntry[] = [];
  private readonly pendingHidden = new Map<string, PendingHiddenBranch>();
  private readonly nativeJobs = new Map<string, { stop: () => void; timeout: ReturnType<typeof setTimeout> }>();
  private readonly liveCards = new Map<string, LiveCard>();
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

  private mergedCards(): Card[] {
    if (!this.liveCards.size) return this.document.cards;
    const overlays = new Map<string, Card>();
    const appended: Card[] = [];
    for (const live of this.liveCards.values()) {
      if (live.targetID) overlays.set(live.targetID, live.card);
      else appended.push(live.card);
    }
    const base = overlays.size
      ? this.document.cards.map((card) => overlays.get(card.id) ?? card)
      : this.document.cards;
    return appended.length ? [...base, ...appended] : base;
  }

  private snapshot(): Snapshot {
    const busy = this.nativeJobs.size > 0 || this.liveCards.size > 0;
    return {
      document: this.liveCards.size ? { ...this.document, cards: this.mergedCards() } : this.document,
      paper: this.host.paper,
      undo: this.previous.length > 0 && !busy,
      redo: this.next.length > 0 && !busy,
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
    const previousSaved = this.saved;
    const previousError = this.saveError;
    try {
      await this.host.save(document);
      this.saved = document === this.document;
      this.saveError = undefined;
    } catch (error) {
      this.saved = false;
      this.saveError = errorMessage(error).slice(0, 1000);
    }
    if (this.saved !== previousSaved || this.saveError !== previousError) {
      this.emit();
    }
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
    const card = this.liveCards.get(id)?.card ?? this.document.cards.find((entry) => entry.id === id);
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

  private findLiveForTurn(conversationKey: number, turn: ConversationTurn): LiveCard | undefined {
    for (const live of this.liveCards.values()) {
      if (live.conversationKey !== conversationKey) continue;
      if (live.turnID === turn.id) return live;
      if (turn.messageIndex !== undefined && live.messageIndex === turn.messageIndex) return live;
    }
    return undefined;
  }

  private commitSyncedCards(synced: Card[]) {
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
    this.update(apply(this.document.cards), false);
    this.scheduleSave();
  }

  private streamNativeBranch(id: string, changes: Partial<Card>): boolean {
    const card = this.document.cards.find((entry) => entry.id === id);
    if (!card) return false;
    const patched = { ...card, ...changes };
    if (JSON.stringify(patched) === JSON.stringify(card)) return false;
    this.document = {
      ...this.document,
      cards: this.document.cards.map((entry) => entry.id === id ? patched : entry),
    };
    this.emit({ type: "card", card: patched });
    return true;
  }

  syncConversation(turns: ConversationTurn[], partial = false, activeConversationKey?: number): Promise<SyncOutcome> {
    return this.serial(() => {
      if (this.disposed) return "none";
      const convKey = activeConversationKey ?? (turns.length ? Number(turns[0].id.split(":", 1)[0]) || 0 : 0);
      const existing = this.document.cards;
      const existingIDs = new Set(existing.map((card) => card.id));
      for (const id of [...this.pendingHidden.keys()]) {
        if (existingIDs.has(id)) this.pendingHidden.delete(id);
      }
      const hidden = new Set(this.document.hiddenTurns ?? []);
      let promotedHidden = false;
      const visibleTurns: ConversationTurn[] = [];
      for (const turn of turns) {
        if (!turn.streaming && hidden.has(turn.id)) continue;
        const pending = matchPendingHidden(this.pendingHidden, turn);
        if (pending) {
          if (turn.streaming) continue;
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
      let emittedSnapshot = false;
      let emittedCard = false;
      let removedLive = false;
      if (promotedHidden) {
        this.document = { ...this.document, hiddenTurns: [...hidden].slice(-1000) };
        this.saved = false;
        this.emit();
        this.scheduleSave();
        emittedSnapshot = true;
      }
      if (!visibleTurns.length) {
        for (const [id, live] of [...this.liveCards.entries()]) {
          if (convKey && live.conversationKey !== convKey) continue;
          this.liveCards.delete(id);
          removedLive = true;
        }
        if (removedLive && !emittedSnapshot) {
          this.emit();
          emittedSnapshot = true;
        }
        return emittedSnapshot ? "snapshot" : "none";
      }
      const completedTurns = visibleTurns.filter((turn) => !turn.streaming);
      const streamingTurns = visibleTurns.filter((turn) => turn.streaming);
      const activeLiveIDs = new Set<string>();
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

      for (const turn of completedTurns) {
        const branch = matchBranch(turn);
        if (!branch) continue;
        claimedTurnIDs.add(turn.id);
        matchedBranchIDs.add(branch.id);
        if (this.liveCards.delete(branch.id)) removedLive = true;
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
        emittedSnapshot = true;
      }
      for (const turn of streamingTurns) {
        const branch = matchBranch(turn);
        if (!branch) continue;
        claimedTurnIDs.add(turn.id);
        matchedBranchIDs.add(branch.id);
        const messageIndex = turn.messageIndex ?? branch.messageIndex;
        if (branch.status === "streaming" && !branch.nativeTurn) {
          if (this.streamNativeBranch(branch.id, {
            title: turn.prompt.slice(0, 80), prompt: turn.prompt, answer: turn.answer,
            sources: turn.sources, messageIndex,
          })) emittedCard = true;
        } else {
          const key = Number(turn.id.split(":", 1)[0]) || branch.nativeBranch || convKey;
          const existingLive = this.liveCards.get(branch.id);
          const updated: Card = {
            ...branch,
            title: turn.prompt.slice(0, 80), prompt: turn.prompt, answer: turn.answer,
            sources: turn.sources, messageIndex, status: "streaming",
          };
          activeLiveIDs.add(branch.id);
          if (!existingLive) {
            this.liveCards.set(branch.id, {
              conversationKey: key, messageIndex, turnID: turn.id, targetID: branch.id, card: updated,
            });
            this.emit();
            emittedSnapshot = true;
          } else {
            existingLive.turnID = turn.id;
            existingLive.messageIndex = messageIndex;
            if (JSON.stringify(existingLive.card) !== JSON.stringify(updated)) {
              existingLive.card = updated;
              this.emit({ type: "card", card: updated });
              emittedCard = true;
            }
          }
        }
      }

      const promotedLive = new Map<string, Card>();
      const partialPromoted: Card[] = [];
      for (const turn of completedTurns) {
        if (claimedTurnIDs.has(turn.id)) continue;
        const key = Number(turn.id.split(":", 1)[0]) || convKey;
        const live = key ? this.findLiveForTurn(key, turn) : undefined;
        if (!live) continue;
        this.liveCards.delete(live.card.id);
        removedLive = true;
        if (!partial) {
          if (!live.targetID) promotedLive.set(turn.id, live.card);
          continue;
        }
        const persistedIDs = new Set(this.document.cards.map((card) => card.id));
        if (!live.card.parents.every((parent) => persistedIDs.has(parent))) continue;
        const finalized: Card = live.card.kind === "response"
          ? {
            ...live.card,
            importedTurn: turn.id,
            messageIndex: turn.messageIndex,
            title: turn.prompt.slice(0, 80),
            prompt: turn.prompt,
            answer: turn.answer,
            sources: turn.sources,
            status: turn.stopped ? "stopped" : "done",
          }
          : {
            ...live.card,
            nativeBranch: key || live.card.nativeBranch,
            nativeTurn: turn.id,
            messageIndex: turn.messageIndex,
            title: turn.prompt.slice(0, 80),
            prompt: turn.prompt,
            answer: turn.answer,
            sources: turn.sources,
            status: turn.stopped ? "stopped" : "done",
          };
        partialPromoted.push(finalized);
        claimedTurnIDs.add(turn.id);
      }
      if (partialPromoted.length) {
        this.commitSyncedCards(partialPromoted);
        emittedSnapshot = true;
      }

      const syncedMain: Card[] = [];
      if (!partial) {
        const latest = this.document.cards;
        const latestByTurn = new Map(latest.filter((card) => card.importedTurn).map((card) => [card.importedTurn!, card]));
        const unclaimed = completedTurns.filter((turn) => !claimedTurnIDs.has(turn.id));
        const lastExistingIndex = unclaimed.findLastIndex((turn) => latestByTurn.has(turn.id));
        let usedReplacement = false;
        const synced: Card[] = [];
        const added: Card[] = [];
        const conversationKey = Number(completedTurns[0]?.id.split(":", 1)[0]) || convKey;
        const branchPool = latest.filter((card) =>
          card.nativeBranch === conversationKey && card.nativeTurn && activeTurnIDs.has(card.nativeTurn));
        for (const [unclaimedIndex, turn] of unclaimed.entries()) {
          const previous = syncedMain.at(-1);
          const existingMain = latestByTurn.get(turn.id);
          const promoted = promotedLive.get(turn.id);
          if (!existingMain && turn.quotedTexts?.length && conversationKey) {
            const candidates = [...branchPool, ...syncedMain, ...added].filter((card) =>
              card.answer && (turn.messageIndex === undefined || card.messageIndex === undefined || card.messageIndex < turn.messageIndex));
            const quotedParents = findQuotedParents(candidates, turn.quotedTexts);
            if (quotedParents.length) {
              if (latest.length + added.length >= 1000) continue;
              const branchPos = promoted ? { x: promoted.x, y: promoted.y } : nextPosition([...latest, ...added], quotedParents);
              const branchCard: Card = {
                id: promoted?.id ?? `llm:${turn.id}`,
                ...branchPos,
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
          const position = current ?? promoted ?? (previous
            ? { x: previous.x, y: previous.y + 420 }
            : nextPosition(latest, []));
          let { x, y } = position;
          while (!current && !promoted && (latest.some(overlaps) || added.some(overlaps))) y += 420;
          function overlaps(card: Card) {
            return Math.abs(card.x - x) < 360 && Math.abs(card.y - y) < 400;
          }
          const updated: Card = {
            id: current?.id ?? promoted?.id ?? `llm:${turn.id}`,
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
        if (!synced.every((card) => card.importedTurn && latestByTurn.get(card.importedTurn) === card)) {
          this.commitSyncedCards(synced);
          emittedSnapshot = true;
        }
      }

      for (const turn of streamingTurns) {
        if (claimedTurnIDs.has(turn.id)) continue;
        const key = Number(turn.id.split(":", 1)[0]) || convKey;
        if (!key) continue;
        const existingLive = this.findLiveForTurn(key, turn);
        if (existingLive) {
          activeLiveIDs.add(existingLive.card.id);
          const nextMessageIndex = turn.messageIndex ?? existingLive.messageIndex;
          const updated: Card = {
            ...existingLive.card,
            ...(existingLive.card.kind === "response" ? { importedTurn: turn.id } : {}),
            messageIndex: nextMessageIndex,
            title: turn.prompt.slice(0, 80),
            prompt: turn.prompt,
            answer: turn.answer,
            sources: turn.sources,
            status: "streaming",
          };
          existingLive.turnID = turn.id;
          existingLive.messageIndex = nextMessageIndex;
          if (JSON.stringify(existingLive.card) !== JSON.stringify(updated)) {
            existingLive.card = updated;
            this.emit({ type: "card", card: updated });
            emittedCard = true;
          }
          continue;
        }
        const target = this.document.cards.find((card) =>
          card.kind === "response" && (
            card.importedTurn === turn.id ||
            (turn.messageIndex !== undefined && card.importedTurn?.startsWith(`${key}:`) &&
              card.messageIndex === turn.messageIndex && !activeTurnIDs.has(card.importedTurn))
          ));
        if (target) {
          const updated: Card = {
            ...target,
            importedTurn: turn.id,
            messageIndex: turn.messageIndex ?? target.messageIndex,
            title: turn.prompt.slice(0, 80),
            prompt: turn.prompt,
            answer: turn.answer,
            sources: turn.sources,
            status: "streaming",
          };
          this.liveCards.set(target.id, {
            conversationKey: key, messageIndex: turn.messageIndex, turnID: turn.id, targetID: target.id, card: updated,
          });
          activeLiveIDs.add(target.id);
          this.emit();
          emittedSnapshot = true;
          continue;
        }
        const allCards = this.mergedCards();
        if (allCards.length >= 1000) continue;
        const baseID = turn.id.includes(":streaming:")
          ? `live:${key}:${turn.messageIndex ?? globalThis.crypto.randomUUID()}`
          : `llm:${turn.id}`;
        const id = uniqueCardID(baseID, allCards);
        let liveCard: Card | undefined;
        if (turn.quotedTexts?.length) {
          const candidates = allCards.filter((card) =>
            card.answer &&
            (card.nativeBranch === key || card.importedTurn?.startsWith(`${key}:`)) &&
            (turn.messageIndex === undefined || card.messageIndex === undefined || card.messageIndex < turn.messageIndex));
          const quotedParents = findQuotedParents(candidates, turn.quotedTexts);
          if (quotedParents.length) {
            liveCard = {
              id,
              ...nextPosition(allCards, quotedParents),
              kind: quotedParents.length > 1 ? "synthesis" : "branch",
              nativeBranch: key,
              messageIndex: turn.messageIndex,
              parents: quotedParents.map((parent) => parent.id),
              quote: turn.quotedTexts.join("\n\n").slice(0, 50000),
              title: turn.prompt.slice(0, 80),
              prompt: turn.prompt,
              answer: turn.answer,
              sources: turn.sources,
              status: "streaming",
            };
          }
        }
        if (!liveCard) {
          const previous = syncedMain.at(-1) ?? allCards.findLast((card) =>
            card.kind === "response" &&
            card.importedTurn?.startsWith(`${key}:`) &&
            (turn.messageIndex === undefined || card.messageIndex === undefined || card.messageIndex < turn.messageIndex));
          const position = previous
            ? { x: previous.x, y: previous.y + 420 }
            : nextPosition(allCards, []);
          let { x, y } = position;
          while (allCards.some((card) => Math.abs(card.x - x) < 360 && Math.abs(card.y - y) < 400)) y += 420;
          liveCard = {
            id,
            x, y,
            kind: "response",
            importedTurn: turn.id,
            messageIndex: turn.messageIndex,
            parents: previous ? [previous.id] : [],
            title: turn.prompt.slice(0, 80),
            prompt: turn.prompt,
            answer: turn.answer,
            sources: turn.sources,
            status: "streaming",
          };
        }
        this.liveCards.set(liveCard.id, {
          conversationKey: key, messageIndex: turn.messageIndex, turnID: turn.id, card: liveCard,
        });
        activeLiveIDs.add(liveCard.id);
        this.emit();
        this.emit({ type: "focus", id: liveCard.id });
        emittedSnapshot = true;
      }

      for (const [id, live] of [...this.liveCards.entries()]) {
        if (convKey && live.conversationKey !== convKey) continue;
        if (!activeLiveIDs.has(id)) {
          this.liveCards.delete(id);
          removedLive = true;
        }
      }
      if (removedLive && !emittedSnapshot) {
        this.emit();
        emittedSnapshot = true;
      }
      return emittedSnapshot ? "snapshot" : emittedCard ? "card" : "none";
    });
  }

  submitNativeBranch(
    ids: string[], prompt: string, quote: string | undefined, conversationKey: number,
    send: (payload: NativeBranchSubmission) => Promise<{ messageIndex?: number } | void>, stop: () => void,
  ) {
    return this.serial(async () => {
      if (this.disposed) throw new Error("画布已关闭。");
      const parents = [...new Set(ids)].map((id) => this.getCard(id));
      const view = this.liveCards.size ? { ...this.document, cards: this.mergedCards() } : this.document;
      const path = ancestors(view, parents.map((parent) => parent.id));
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
      const view = this.liveCards.size ? { ...this.document, cards: this.mergedCards() } : this.document;
      const path = ancestors(view, parents.map((parent) => parent.id));
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
    const pendingId = conversationKey ? `note:${globalThis.crypto.randomUUID()}` : undefined;
    let sent = false;
    if (pendingId) {
      this.pendingHidden.set(pendingId, {
        id: pendingId,
        conversationKey,
        prompt: payload.prompt,
      });
    }
    let text: string;
    try {
      text = await send(payload, ({ messageIndex }) => {
        sent = true;
        if (!pendingId) return;
        this.pendingHidden.set(pendingId, {
          id: pendingId,
          conversationKey,
          messageIndex,
          prompt: payload.prompt,
        });
      });
    } catch (error) {
      if (pendingId && !sent) this.pendingHidden.delete(pendingId);
      throw error;
    }
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
          let movedLive = false;
          for (const live of this.liveCards.values()) {
            const next = positions.get(live.card.id);
            if (!next) continue;
            live.card = { ...live.card, ...next };
            movedLive = true;
          }
          const movedPersisted = this.document.cards.some((card) => positions.has(card.id));
          if (!movedPersisted) {
            if (movedLive) this.emit();
            return;
          }
          this.update(this.document.cards.map((card) => ({ ...card, ...positions.get(card.id) })));
          break;
        }
        case "viewport": {
          const current = this.document.viewport;
          if (current.x === command.viewport.x && current.y === command.viewport.y && current.zoom === command.viewport.zoom) return;
          this.document = { ...this.document, viewport: command.viewport };
          if (this.document.cards.length || this.document.hiddenTurns?.length) this.scheduleSave();
          return;
        }
        case "remove": {
          const allCards = this.mergedCards();
          const ids = new Set(command.ids);
          for (const card of allCards) if (card.parents.some((parent) => ids.has(parent))) ids.add(card.id);
          if (allCards.some((card) => ids.has(card.id) && card.importedTurn)) {
            throw new Error("请在论文对话中移除这条消息。");
          }
          const removed = allCards.filter((card) => ids.has(card.id));
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
            this.liveCards.delete(id);
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
          if (this.nativeJobs.size || this.liveCards.size) return;
          const from = command.type === "undo" ? this.previous : this.next;
          const to = command.type === "undo" ? this.next : this.previous;
          const entry = from.pop();
          if (!entry) return;
          to.push({ cards: this.document.cards, hiddenTurns: this.document.hiddenTurns ?? [] });
          this.update(entry.cards, false, entry.hiddenTurns);
          break;
        }
        case "stop":
          const job = this.nativeJobs.get(command.id);
          if (job) {
            job.stop();
            return true;
          }
          return false;
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
    this.liveCards.clear();
    this.listeners.clear();
    const pendingSave = Boolean(this.queuedSave) || !this.saved;
    clearTimeout(this.queuedSave);
    this.queuedSave = undefined;
    if (pendingSave) await this.serial(() => this.save());
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

function uniqueCardID(base: string, existing: readonly Card[]) {
  const used = new Set(existing.map((card) => card.id));
  if (!used.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}#${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function replacedNativeBranch(
  cards: Card[], turn: ConversationTurn, activeTurnIDs: ReadonlySet<string>, matchedBranchIDs: ReadonlySet<string>,
) {
  if (turn.messageIndex === undefined) return;
  const [key, timestamp] = turn.id.split(":");
  const streamingPending = Boolean(turn.streaming && timestamp === "streaming");
  if (!streamingPending && !Number.isSafeInteger(Number(timestamp))) return;
  const keyNumber = Number(key);
  const candidates = cards.filter((card) => {
    if (matchedBranchIDs.has(card.id) || card.nativeBranch !== keyNumber ||
        !card.nativeTurn || activeTurnIDs.has(card.nativeTurn) ||
        card.messageIndex !== turn.messageIndex) return false;
    const [oldKey, oldTimestamp] = card.nativeTurn.split(":");
    return oldKey === key && (streamingPending || Number(oldTimestamp) < Number(timestamp));
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
