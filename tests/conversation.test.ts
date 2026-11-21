import { mkdtemp, mkdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zlibSync } from "fflate";
import { ancestors, conversationCards, emptyDocument } from "../shared/graph.ts";
import { nativeBranchPrompt, readNativePrompt } from "../shared/question.ts";
import { documentSchema, type CanvasDocument, type Reference } from "../shared/schema.ts";
import { canvasFilePath, migrateLegacyNotes, zoteroHost } from "../src/library.ts";
import { CanvasSession, type NativeBranchSubmission } from "../src/session.ts";

test("conversation backfill preserves existing cards and updates them across layout undo", async () => {
  const paper: Reference = {
    uri: "zotero://select/library/items/ABCDEFGH",
    title: "Fixture", authors: "", year: "", abstract: "",
  };
  const existing: CanvasDocument = {
    ...emptyDocument(),
    cards: [
      {
        id: "existing-response", importedTurn: "10:200", kind: "response", title: "Later question",
        prompt: "Later question", answer: "Previously imported", status: "done", x: 42, y: 54, parents: [],
      },
      { id: "existing-branch", kind: "branch", title: "Follow-up", x: 460, y: 54, parents: ["existing-response"] },
    ],
  };
  const session = new CanvasSession({
    paper,
    load: async () => existing,
    save: async (document) => { documentSchema.parse(document); },
    image: async () => null,
    open: () => {},
    search: async () => [],
    reference: async () => paper,
    note: async () => "",
  });
  try {
    await session.command({ type: "move", positions: [{ id: "existing-response", x: 50, y: 60 }] });
    const earlier = { id: "10:100", prompt: "Earlier question", answer: "Earlier answer", sources: [] };
    const later = { id: "10:200", prompt: "Later question", answer: "Updated original reply", sources: [] };
    await session.syncConversation([earlier, later]);
    await session.syncConversation([earlier, later]);
    const { document } = await session.ready();
    assert.equal(document.cards.length, 3);
    assert.deepEqual(ancestors(document, ["existing-branch"]).map((card) => card.id), [
      "llm:10:100", "existing-response", "existing-branch",
    ]);
    assert.equal(document.cards.find((card) => card.id === "existing-response")?.x, 50);
    assert.deepEqual(conversationCards(document.cards, new Set()), []);
    await session.command({ type: "undo" });
    const afterUndo = (await session.ready()).document.cards;
    assert.equal(afterUndo.length, 3);
    assert.equal(afterUndo.find((card) => card.id === "existing-response")?.x, 42);
    assert.equal(afterUndo.find((card) => card.id === "existing-response")?.answer, later.answer);
    await session.syncConversation([later]);
    const afterRemoval = (await session.ready()).document.cards;
    const projected = conversationCards(afterRemoval, new Set([later.id]));
    assert.deepEqual(projected.map((card) => [card.id, card.parents]), [
      ["existing-response", []], ["existing-branch", ["existing-response"]],
    ]);
    let submission!: NativeBranchSubmission;
    await session.syncConversation([{ ...earlier, answer: "x".repeat(64500) }, later]);
    const quotedBranchID = await session.submitNativeBranch(["existing-response"], "Why?", "A selected phrase", 10, async (payload) => {
      submission = payload;
      return { messageIndex: 4 };
    }, () => {});
    assert.equal(submission.prompt, "Why?");
    assert.deepEqual(submission.quotes, ["A selected phrase"]);
    assert.match(submission.markdown, /本次追问选中的文字：\nA selected phrase/);
    assert.match(submission.markdown, /Updated original reply/);
    assert.ok(submission.markdown.indexOf("A selected phrase") < submission.markdown.indexOf("Earlier question"));
    assert.ok(!submission.markdown.includes("画布参考材料（分支"));
    await session.syncConversation([{ id: "10:300", messageIndex: 4, prompt: "Why?", answer: "Native answer", sources: [] }], true);
    const native = (await session.ready()).document.cards;
    assert.equal(native.filter((card) => card.importedTurn).length, 2);
    assert.deepEqual(native.find((card) => card.id === quotedBranchID)?.parents, ["existing-response"]);
    assert.equal(native.find((card) => card.id === quotedBranchID)?.answer, "Native answer");
    assert.equal(native.find((card) => card.id === quotedBranchID)?.nativeTurn, "10:300");
    assert.equal(native.find((card) => card.id === quotedBranchID)?.status, "done");
    assert.ok(conversationCards(native, new Set(["10:100", "10:200", "10:300"]), 10).some((card) => card.id === quotedBranchID));

    // Editing a native branch in LLM for Zotero replaces the same branch card in place
    await session.syncConversation([
      earlier, later,
      { id: "10:350", messageIndex: 4, prompt: "Why really?", answer: "Edited native answer", sources: [] },
    ]);
    const afterBranchEdit = (await session.ready()).document.cards;
    assert.equal(afterBranchEdit.filter((card) => card.importedTurn).length, 2);
    assert.equal(afterBranchEdit.find((card) => card.id === quotedBranchID)?.prompt, "Why really?");
    assert.equal(afterBranchEdit.find((card) => card.id === quotedBranchID)?.answer, "Edited native answer");
    assert.equal(afterBranchEdit.find((card) => card.id === quotedBranchID)?.nativeTurn, "10:350");

    // Branching a whole card in the same conversation quotes the parent card answer directly
    const wholeCardBranchID = await session.submitNativeBranch(["existing-response"], "Explain this", undefined, 10, async (payload) => {
      submission = payload;
      return { messageIndex: 6 };
    }, () => {});
    assert.equal(submission.prompt, "Explain this");
    assert.deepEqual(submission.quotes, ["Updated original reply"]);
    assert.match(submission.markdown, /本次追问的来源卡片：\n\n### #2 Later question[\s\S]*Updated original reply/);
    assert.ok(submission.markdown.indexOf("Updated original reply") < submission.markdown.indexOf("Earlier question"));
    await session.syncConversation([{
      id: "10:360", messageIndex: 6, prompt: "Explain this", answer: "Explanation", sources: [],
    }], true);
    assert.equal((await session.ready()).document.cards.find((card) => card.id === wholeCardBranchID)?.nativeTurn, "10:360");

    // Legacy branch prompt marker remains readable
    const legacyPrompt = nativeBranchPrompt(wholeCardBranchID, "Legacy?", "context");
    assert.deepEqual(readNativePrompt(legacyPrompt).question, "Legacy?");
    assert.equal(readNativePrompt(legacyPrompt).branchID, wholeCardBranchID);

    const oldTail = { id: "10:400", messageIndex: 8, prompt: "Discarded question", answer: "Discarded answer", sources: [] };
    await session.syncConversation([
      earlier, later,
      { id: "10:350", messageIndex: 4, prompt: "Why really?", answer: "Edited native answer", sources: [] },
      { id: "10:360", messageIndex: 6, prompt: "Explain this", answer: "Explanation", sources: [] },
      oldTail,
    ]);
    const tailID = (await session.ready()).document.cards.find((card) => card.importedTurn === oldTail.id)!.id;
    const discardedBranch = await session.submitNativeBranch([tailID], "Discarded follow-up", undefined, 10, async () => ({ messageIndex: 10 }), () => {});
    const oldBranch = { id: "10:500", messageIndex: 10, prompt: "Discarded follow-up", answer: "Follow-up answer", sources: [] };
    await session.syncConversation([
      earlier, later,
      { id: "10:350", messageIndex: 4, prompt: "Why really?", answer: "Edited native answer", sources: [] },
      { id: "10:360", messageIndex: 6, prompt: "Explain this", answer: "Explanation", sources: [] },
      oldTail, oldBranch,
    ]);
    await session.command({ type: "move", positions: [{ id: "existing-response", x: 75, y: 120 }] });
    const edited = { id: "10:600", messageIndex: 2, prompt: "Edited question", answer: "Regenerated answer", sources: [] };
    const active = new Set([earlier.id, edited.id]);
    await session.syncConversation([earlier, edited], true);
    assert.ok((await session.ready()).document.cards.some((card) => card.importedTurn === later.id));
    await session.syncConversation([earlier, edited]);
    const assertRewrite = async (x: number) => {
      const { document } = await session.ready();
      documentSchema.parse(document);
      const visible = conversationCards(document.cards, active, 10);
      assert.deepEqual(visible.filter((card) => card.importedTurn).map((card) => [card.id, card.answer]), [
        ["llm:10:100", earlier.answer], ["existing-response", edited.answer],
      ]);
      assert.equal(visible.find((card) => card.id === "existing-response")?.x, x);
      assert.ok(!visible.some((card) => card.id === tailID || card.id === discardedBranch));
      assert.ok(!document.cards.some((card) => card.importedTurn === later.id));
    };
    await assertRewrite(75);
    await session.command({ type: "undo" });
    await assertRewrite(42);
  } finally {
    await session.close();
  }
});

test("manual model quotes in the paper chat attach as branches without breaking the main spine", async () => {
  const paper: Reference = {
    uri: "zotero://select/library/items/ABCDEFGH",
    title: "Fixture", authors: "", year: "", abstract: "",
  };
  const session = new CanvasSession({
    paper,
    load: async () => null,
    save: async (document) => { documentSchema.parse(document); },
    image: async () => null,
    open: () => {},
    search: async () => [],
    reference: async () => paper,
    note: async () => "",
  });
  try {
    const turn1 = { id: "30:100", messageIndex: 0, prompt: "First", answer: "AFL uses edge coverage with a 64 KiB bitmap.", sources: [] };
    const turn2 = { id: "30:200", messageIndex: 2, prompt: "Second", answer: "Self-loops collapse to zero without right shift.", sources: [] };
    const manualQuote = {
      id: "30:300", messageIndex: 4, prompt: "Explain bitmap",
      quotedTexts: ["edge coverage with a 64 KiB bitmap"],
      answer: "Each slot counts edge hits.", sources: [],
    };
    const turn3 = { id: "30:400", messageIndex: 6, prompt: "Third", answer: "Main line continues.", sources: [] };
    const manualSynthesis = {
      id: "30:500", messageIndex: 8, prompt: "Compare both",
      quotedTexts: ["64 KiB bitmap", "Self-loops collapse to zero"],
      answer: "Combined explanation.", sources: [],
    };
    await session.syncConversation([turn1, turn2, manualQuote, turn3, manualSynthesis]);
    const { document } = await session.ready();
    const byId = new Map(document.cards.map((card) => [card.id, card]));
    assert.equal(byId.get("llm:30:300")?.kind, "branch");
    assert.deepEqual(byId.get("llm:30:300")?.parents, ["llm:30:100"]);
    assert.equal(byId.get("llm:30:300")?.nativeTurn, "30:300");
    assert.equal(byId.get("llm:30:400")?.kind, "response");
    assert.deepEqual(byId.get("llm:30:400")?.parents, ["llm:30:200"]);
    assert.equal(byId.get("llm:30:500")?.kind, "synthesis");
    assert.deepEqual(byId.get("llm:30:500")?.parents, ["llm:30:100", "llm:30:200"]);

    // Subsequent sync keeps manual-quote branches stable and editing replaces in place
    await session.syncConversation([
      turn1, turn2,
      { ...manualQuote, id: "30:350", prompt: "Explain bitmap deeply", answer: "Updated slot explanation." },
      turn3, manualSynthesis,
    ]);
    const updated = (await session.ready()).document.cards.find((card) => card.id === "llm:30:300");
    assert.equal(updated?.nativeTurn, "30:350");
    assert.equal(updated?.answer, "Updated slot explanation.");
    assert.deepEqual(updated?.parents, ["llm:30:100"]);
  } finally {
    await session.close();
  }
});

test("archiving native branches records hidden turns across resync, reload, undo, redo, cascade, and streaming", async () => {
  const paper: Reference = {
    uri: "zotero://select/library/items/ABCDEFGH",
    title: "Fixture", authors: "", year: "", abstract: "",
  };
  let savedDocument: CanvasDocument | null = null;
  const makeHost = () => ({
    paper,
    load: async () => savedDocument,
    save: async (document: CanvasDocument) => {
      savedDocument = structuredClone(documentSchema.parse(document));
    },
    image: async () => null,
    open: () => {},
    search: async () => [],
    reference: async () => paper,
    note: async () => "",
  });

  const turn1 = { id: "40:100", messageIndex: 0, prompt: "First", answer: "AFL uses edge coverage with a 64 KiB bitmap.", sources: [] };
  const turn2 = { id: "40:200", messageIndex: 2, prompt: "Second", answer: "Right shift distinguishes A->B from B->A.", sources: [] };
  const branchTurn = {
    id: "40:300", messageIndex: 4, prompt: "Test branch",
    quotedTexts: ["Right shift distinguishes A->B from B->A."],
    answer: "", stopped: true, sources: [],
  };
  const childBranchTurn = {
    id: "40:400", messageIndex: 6, prompt: "Follow-up on branch",
    answer: "Child branch answer.", sources: [],
  };
  const manualBranchTurn = {
    id: "40:450", messageIndex: 8, prompt: "Manual quote branch",
    quotedTexts: ["64 KiB bitmap"],
    answer: "Manual quote answer.", sources: [],
  };
  const turn3 = { id: "40:500", messageIndex: 10, prompt: "Third", answer: "Main spine continues.", sources: [] };

  const session = new CanvasSession(makeHost());
  try {
    await session.syncConversation([turn1, turn2]);
    const branchID = await session.submitNativeBranch(["llm:40:200"], "Test branch", "Right shift distinguishes A->B from B->A.", 40,
      async () => ({ messageIndex: 4 }), () => {});
    await session.syncConversation([turn1, turn2, branchTurn]);

    const childBranchID = await session.submitNativeBranch([branchID], "Follow-up on branch", undefined, 40,
      async () => ({ messageIndex: 6 }), () => {});
    await session.syncConversation([turn1, turn2, branchTurn, childBranchTurn, manualBranchTurn]);

    // Cascade-archiving parent native branch hides both parent and child turns
    await session.command({ type: "remove", ids: [branchID] });
    const afterRemove = (await session.ready()).document;
    assert.ok(!afterRemove.cards.some((card) => card.id === branchID || card.id === childBranchID));
    assert.deepEqual(afterRemove.hiddenTurns, ["40:300", "40:400"]);

    // Returning to chat and back to canvas does not rebuild archived branches (with or without quotes) or break main spine
    await session.syncConversation([
      turn1, turn2, branchTurn,
      { ...childBranchTurn, quotedTexts: undefined },
      manualBranchTurn, turn3,
    ]);
    const afterResync = (await session.ready()).document;
    assert.deepEqual(afterResync.cards.map((card) => card.id), ["llm:40:100", "llm:40:200", "llm:40:450", "llm:40:500"]);
    assert.deepEqual(afterResync.cards.find((card) => card.id === "llm:40:500")?.parents, ["llm:40:200"]);

    // Undo restores both branch cards and clears their hiddenTurns; resync keeps them visible
    await session.command({ type: "undo" });
    const afterUndo = (await session.ready()).document;
    assert.ok(afterUndo.cards.some((card) => card.id === branchID));
    assert.ok(afterUndo.cards.some((card) => card.id === childBranchID));
    assert.equal(afterUndo.hiddenTurns, undefined);
    await session.syncConversation([turn1, turn2, branchTurn, childBranchTurn, manualBranchTurn, turn3]);
    assert.ok((await session.ready()).document.cards.some((card) => card.id === branchID));

    // Redo re-archives both branches and re-records hiddenTurns
    await session.command({ type: "redo" });
    assert.deepEqual((await session.ready()).document.hiddenTurns, ["40:300", "40:400"]);
    await session.syncConversation([turn1, turn2, branchTurn, childBranchTurn, manualBranchTurn, turn3]);
    assert.ok(!(await session.ready()).document.cards.some((card) => card.id === branchID || card.id === childBranchID));

    // Archiving a manual-quote native branch also persists in hiddenTurns
    await session.command({ type: "remove", ids: ["llm:40:450"] });
    await session.syncConversation([turn1, turn2, branchTurn, childBranchTurn, manualBranchTurn, turn3]);
    assert.deepEqual((await session.ready()).document.cards.map((card) => card.id), ["llm:40:100", "llm:40:200", "llm:40:500"]);
    assert.deepEqual((await session.ready()).document.hiddenTurns, ["40:300", "40:400", "40:450"]);

    // Archiving a streaming native branch before nativeTurn is bound stops it and promotes the stopped turn when it arrives
    let stoppedCount = 0;
    const streamingID = await session.submitNativeBranch(["llm:40:500"], "Cancelled live", undefined, 40,
      async () => ({ messageIndex: 12 }), () => { stoppedCount += 1; });
    await session.command({ type: "remove", ids: [streamingID] });
    assert.equal(stoppedCount, 1);
    const stoppedLiveTurn = {
      id: "40:600", messageIndex: 12, prompt: "Cancelled live",
      quotedTexts: ["Main spine continues."], answer: "", stopped: true, sources: [],
    };
    await session.syncConversation([turn1, turn2, branchTurn, childBranchTurn, manualBranchTurn, turn3, stoppedLiveTurn], true);
    await session.syncConversation([turn1, turn2, branchTurn, childBranchTurn, manualBranchTurn, turn3, stoppedLiveTurn]);
    const afterStreamingArchive = (await session.ready()).document;
    assert.deepEqual(afterStreamingArchive.cards.map((card) => card.id), ["llm:40:100", "llm:40:200", "llm:40:500"]);
    assert.deepEqual(afterStreamingArchive.hiddenTurns, ["40:300", "40:400", "40:450", "40:600"]);
    await session.command({ type: "save" });
  } finally {
    await session.close();
  }

  // Persisted hiddenTurns survive reload into a fresh CanvasSession
  const reloaded = new CanvasSession(makeHost());
  try {
    await reloaded.syncConversation([
      turn1, turn2, branchTurn, childBranchTurn, manualBranchTurn, turn3,
      { id: "40:600", messageIndex: 12, prompt: "Cancelled live", quotedTexts: ["Main spine continues."], answer: "", stopped: true, sources: [] },
    ]);
    const { document } = await reloaded.ready();
    assert.deepEqual(document.cards.map((card) => card.id), ["llm:40:100", "llm:40:200", "llm:40:500"]);
    assert.deepEqual(document.hiddenTurns, ["40:300", "40:400", "40:450", "40:600"]);
  } finally {
    await reloaded.close();
  }
});

test("crystallize delegates note generation to LLM for Zotero, hides utility turn, and preserves collected sources", async () => {
  const paper: Reference = {
    uri: "zotero://select/library/items/ABCDEFGH",
    title: "Fixture", authors: "", year: "", abstract: "",
  };
  const citedRef: Reference = {
    uri: "zotero://select/library/items/REF12345",
    title: "Cited Paper", authors: "Ada Lovelace", year: "1843", abstract: "Foundational notes.",
  };
  let savedNote: { text: string; sources: { label: string; uri: string }[] } | undefined;
  const session = new CanvasSession({
    paper,
    load: async () => null,
    save: async (document) => { documentSchema.parse(document); },
    image: async () => null,
    open: () => {},
    search: async () => [citedRef],
    reference: async () => citedRef,
    note: async (text, sources) => {
      savedNote = { text, sources };
      return "zotero://select/library/items/NOTE0001";
    },
  });
  try {
    const excerptAnchor = { uri: "zotero://open-pdf/library/items/ATTACH01?page=2", page: 2 };
    const answerAnchor = { uri: "zotero://open-pdf/library/items/ATTACH01?page=5", page: 5 };
    await session.addExcerpt({ quote: "Edge bitmap uses >> 1.", anchor: excerptAnchor });
    await session.command({ type: "cite", uri: citedRef.uri });
    const turn1 = { id: "50:100", messageIndex: 0, prompt: "First", answer: "Main answer.", sources: [answerAnchor] };
    await session.syncConversation([turn1]);

    const cards = (await session.ready()).document.cards;
    assert.equal(cards.filter((card) => card.kind === "excerpt").length, 1);
    assert.equal(cards.filter((card) => card.kind === "branch").length, 0);

    const excerptCard = cards.find((card) => card.kind === "excerpt")!;
    const citeCard = cards.find((card) => card.kind === "citation")!;
    const responseCard = cards.find((card) => card.kind === "response")!;
    const branchID = await session.submitNativeBranch(
      [excerptCard.id, citeCard.id, responseCard.id],
      "Combine these",
      undefined,
      50,
      async () => ({ messageIndex: 2 }),
      () => {},
    );
    const branchTurn = {
      id: "50:200", messageIndex: 2, prompt: "Combine these",
      answer: "Synthesized explanation.", sources: [],
    };
    await session.syncConversation([turn1, branchTurn]);

    let capturedPayload!: NativeBranchSubmission;
    const noteURI = await session.crystallize([branchID], 50, async (payload, onSent) => {
      capturedPayload = payload;
      onSent({ messageIndex: 4 });
      return "## 问题\n总结内容";
    });

    assert.equal(noteURI, "zotero://select/library/items/NOTE0001");
    assert.match(capturedPayload.prompt, /整理为中文笔记/);
    assert.match(capturedPayload.markdown, /Edge bitmap uses >> 1\./);
    assert.match(capturedPayload.markdown, /Cited Paper/);
    assert.match(capturedPayload.markdown, /Main answer\./);
    assert.match(capturedPayload.markdown, /Synthesized explanation\./);
    assert.deepEqual(savedNote, {
      text: "## 问题\n总结内容",
      sources: [
        { uri: excerptAnchor.uri, label: "PDF 第 2 页" },
        { uri: citedRef.uri, label: "Cited Paper" },
        { uri: answerAnchor.uri, label: "PDF 第 5 页" },
      ],
    });

    const noteTurn = {
      id: "50:300", messageIndex: 4, prompt: capturedPayload.prompt,
      answer: "## 问题\n总结内容", sources: [],
    };
    await session.syncConversation([turn1, branchTurn, noteTurn]);
    const afterSync = (await session.ready()).document;
    assert.ok(!afterSync.cards.some((card) => card.importedTurn === "50:300" || card.nativeTurn === "50:300"));
    assert.deepEqual(afterSync.hiddenTurns, ["50:300"]);
  } finally {
    await session.close();
  }
});

test("local file storage persists session operations, migrates legacy notes, and skips redundant viewport snapshots", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcanvas-storage-"));
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const previousPathUtils = (globalThis as { PathUtils?: unknown }).PathUtils;
  const previousIOUtils = (globalThis as { IOUtils?: unknown }).IOUtils;

  type FakeNote = {
    id: number;
    key: string;
    libraryID: number;
    parentID: number;
    deleted: boolean;
    dateModified?: string;
    tags: Set<string>;
    content: string;
    erased: boolean;
    isRegularItem: () => boolean;
    hasTag: (tag: string) => boolean;
    getNote: () => string;
    eraseTx: () => Promise<void>;
  };
  type FakePaper = {
    id: number;
    key: string;
    libraryID: number;
    deleted: boolean;
    noteIDs: number[];
    isRegularItem: () => boolean;
    getDisplayTitle: () => string;
    getCreators: () => { firstName: string; lastName: string }[];
    getField: (field: string) => string;
    getNotes: () => number[];
  };

  const notesById = new Map<number, FakeNote>();
  const papersById = new Map<number, FakePaper>();

  function makePaper(id: number, key: string, libraryID = 1): FakePaper {
    const paper: FakePaper = {
      id,
      key,
      libraryID,
      deleted: false,
      noteIDs: [],
      isRegularItem: () => true,
      getDisplayTitle: () => `Paper ${key}`,
      getCreators: () => [{ firstName: "Ada", lastName: "Lovelace" }],
      getField: (field) => field === "date" ? "2026" : "Abstract",
      getNotes: () => paper.noteIDs.filter((noteId) => !notesById.get(noteId)?.erased),
    };
    papersById.set(id, paper);
    return paper;
  }

  function addLegacyNote(paper: FakePaper, id: number, content: string, dateModified = "2026-11-21 10:00:00"): FakeNote {
    const note: FakeNote = {
      id,
      key: `NOTE000${id}`,
      libraryID: paper.libraryID,
      parentID: paper.id,
      deleted: false,
      dateModified,
      tags: new Set(["_zcanvas_data"]),
      content,
      erased: false,
      isRegularItem: () => false,
      hasTag: (tag) => note.tags.has(tag),
      getNote: () => note.content,
      eraseTx: async () => { note.erased = true; },
    };
    Object.defineProperty(note, "parentItem", { get: () => paper });
    notesById.set(id, note);
    paper.noteIDs.push(id);
    return note;
  }

  function encodeLegacyPayload(document: CanvasDocument): string {
    const compressed = zlibSync(strToU8(JSON.stringify(document)), { level: 6 });
    const payload = Buffer.from(compressed).toString("base64");
    return `<h1>Canvas Chat · 画布数据</h1><p>ZCANVAS1:${payload}</p>`;
  }

  class FakeSearch {
    libraryID = 1;
    private tag?: string;
    addCondition(field: string, _operator: string, value: string) {
      if (field === "tag") this.tag = value;
    }
    async search() {
      return [...notesById.values()]
        .filter((note) => !note.erased && !note.deleted && note.libraryID === this.libraryID && (!this.tag || note.hasTag(this.tag)))
        .map((note) => note.id);
    }
  }

  (globalThis as Record<string, unknown>).PathUtils = {
    join: (...parts: string[]) => join(...parts),
  };
  (globalThis as Record<string, unknown>).IOUtils = {
    exists: async (path: string) => {
      try { await stat(path); return true; } catch { return false; }
    },
    makeDirectory: async (path: string) => {
      await mkdir(path, { recursive: true });
    },
    readUTF8: async (path: string) => readFile(path, "utf8"),
    writeUTF8: async (path: string, content: string, options?: { tmpPath?: string }) => {
      if (options?.tmpPath) {
        await writeFile(options.tmpPath, content, "utf8");
        await rename(options.tmpPath, path);
      } else {
        await writeFile(path, content, "utf8");
      }
      return Buffer.byteLength(content);
    },
    remove: async (path: string) => {
      await rm(path, { force: true });
    },
  };
  (globalThis as Record<string, unknown>).Zotero = {
    DataDirectory: { dir: dataDir },
    Schema: { schemaUpdatePromise: Promise.resolve() },
    Libraries: {
      userLibraryID: 1,
      get: (libraryID: number) => libraryID === 1
        ? { libraryID: 1, libraryType: "user", editable: true }
        : { libraryID: 2, libraryType: "group", libraryTypeID: 77, editable: false },
      getAll: () => [
        { libraryID: 1, libraryType: "user", editable: true },
        { libraryID: 2, libraryType: "group", libraryTypeID: 77, editable: false },
      ],
    },
    Items: {
      get: (ids: number[]) => ids.map((id) => notesById.get(id) ?? papersById.get(id)).filter(Boolean),
      getAsync: async (ids: number[]) => ids.map((id) => notesById.get(id) ?? papersById.get(id)).filter(Boolean),
    },
    Search: FakeSearch,
  };

  const win = { ZoteroPane: { loadURI: () => {} } } as unknown as _ZoteroTypes.MainWindow;

  try {
    // 1. Fresh paper saves directly to local file without creating Zotero notes
    const paperA = makePaper(1, "PAPERA01");
    const fileA = canvasFilePath(paperA as unknown as Zotero.Item);
    const sessionA = new CanvasSession(zoteroHost(paperA as unknown as Zotero.Item, win));
    let snapshotEvents = 0;
    sessionA.subscribe((event) => {
      if (event.type === "snapshot") snapshotEvents++;
    });
    try {
      await sessionA.addExcerpt({
        quote: "Local storage excerpt",
        anchor: { uri: "zotero://open-pdf/library/items/ATTACH01?page=1", page: 1 },
      });
      assert.equal(paperA.getNotes().length, 0);
      const savedOnDisk = documentSchema.parse(JSON.parse(await readFile(fileA, "utf8")));
      assert.equal(savedOnDisk.cards.length, 1);
      assert.equal(savedOnDisk.cards[0].quote, "Local storage excerpt");

      // Viewport update while already saved does not emit a redundant snapshot and flushes on close
      const eventsBeforeViewport = snapshotEvents;
      await sessionA.command({ type: "viewport", viewport: { x: 120, y: -45, zoom: 1.25 } });
      assert.equal(snapshotEvents, eventsBeforeViewport);
    } finally {
      await sessionA.close();
    }
    assert.equal(snapshotEvents, 2); // 1 from update(saved=false), 1 from save(saved=true)

    const reloadedA = new CanvasSession(zoteroHost(paperA as unknown as Zotero.Item, win));
    try {
      const snapshot = await reloadedA.ready();
      assert.equal(snapshot.document.cards.length, 1);
      assert.deepEqual(snapshot.document.viewport, { x: 120, y: -45, zoom: 1.25 });
      await reloadedA.command({ type: "remove", ids: [snapshot.document.cards[0].id] });
    } finally {
      await reloadedA.close();
    }
    await assert.rejects(stat(fileA));

    // 2. Startup migration converts legacy _zcanvas_data notes to local files and erases the notes
    const paperB = makePaper(2, "PAPERB02");
    const fileB = canvasFilePath(paperB as unknown as Zotero.Item);
    const olderDoc: CanvasDocument = {
      ...emptyDocument(),
      cards: [{ id: "old-card", parents: [], x: 10, y: 20, kind: "excerpt", title: "Old", quote: "Old quote" }],
    };
    const newerDoc: CanvasDocument = {
      ...emptyDocument(),
      cards: [
        { id: "new-card-1", parents: [], x: 30, y: 40, kind: "excerpt", title: "New 1", quote: "New quote 1" },
        { id: "new-card-2", parents: ["new-card-1"], x: 300, y: 40, kind: "branch", title: "New 2", prompt: "Why?", answer: "Because.", status: "done" },
      ],
    };
    const oldNote = addLegacyNote(paperB, 201, encodeLegacyPayload(olderDoc), "2026-11-20 09:00:00");
    const newNote = addLegacyNote(paperB, 202, encodeLegacyPayload(newerDoc), "2026-11-21 12:00:00");

    await migrateLegacyNotes();
    assert.ok(oldNote.erased);
    assert.ok(newNote.erased);

    const sessionB = new CanvasSession(zoteroHost(paperB as unknown as Zotero.Item, win));
    try {
      const { document } = await sessionB.ready();
      assert.deepEqual(document.cards.map((card) => card.id), ["new-card-1", "new-card-2"]);
      const migratedOnDisk = documentSchema.parse(JSON.parse(await readFile(fileB, "utf8")));
      assert.deepEqual(migratedOnDisk.cards.map((card) => card.id), ["new-card-1", "new-card-2"]);
    } finally {
      await sessionB.close();
    }

    // 3. Corrupted legacy note is preserved (not erased) when migration fails
    const paperC = makePaper(3, "PAPERC03");
    const corruptedNote = addLegacyNote(paperC, 301, "<h1>Canvas Chat · 画布数据</h1><p>ZCANVAS1:not-valid-zlib</p>");
    const sessionC = new CanvasSession(zoteroHost(paperC as unknown as Zotero.Item, win));
    await assert.rejects(sessionC.ready(), /无法读取画布数据笔记/);
    assert.equal(corruptedNote.erased, false);
  } finally {
    (globalThis as Record<string, unknown>).Zotero = previousZotero;
    (globalThis as Record<string, unknown>).PathUtils = previousPathUtils;
    (globalThis as Record<string, unknown>).IOUtils = previousIOUtils;
    await rm(dataDir, { recursive: true, force: true });
  }
});
