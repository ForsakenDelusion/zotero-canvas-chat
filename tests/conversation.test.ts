import { mkdtemp, mkdir, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { strToU8, zlibSync } from "fflate";
import { ancestors, conversationCards, emptyDocument } from "../shared/graph.ts";
import { nativeBranchPrompt, readNativePrompt } from "../shared/question.ts";
import { documentSchema, type CanvasDocument, type Reference } from "../shared/schema.ts";
import { canvasFilePath, makeAnchor, migrateLegacyNotes, parentPaper, zoteroHost } from "../src/library.ts";
import { readerHooks } from "../src/reader.ts";
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

test("streaming main-line and branch turns appear immediately, stream live without disk churn, and promote in place", async () => {
  const paper: Reference = {
    uri: "zotero://select/library/items/STREAM01",
    title: "Streaming Paper", authors: "", year: "", abstract: "",
  };
  let savedDocs: CanvasDocument[] = [];
  const session = new CanvasSession({
    paper,
    load: async () => null,
    save: async (document) => {
      documentSchema.parse(document);
      savedDocs.push(structuredClone(document));
    },
    image: async () => null,
    open: () => {},
    search: async () => [],
    reference: async () => paper,
    note: async () => "zotero://select/library/items/NOTE0001",
  });
  const events: string[] = [];
  const focused: string[] = [];
  const cardUpdates: { id: string; answer?: string; status?: string }[] = [];
  session.subscribe((event) => {
    events.push(event.type);
    if (event.type === "focus") focused.push(event.id);
    if (event.type === "card") cardUpdates.push({ id: event.card.id, answer: event.card.answer, status: event.card.status });
  });

  try {
    // Seed an existing completed main-line turn
    const turn0 = { id: "10:100", messageIndex: 0, prompt: "First question", answer: "First answer", sources: [] };
    await session.syncConversation([turn0], false, 10);
    await session.command({ type: "save" });
    const savesAfterSeed = savedDocs.length;

    // 1. New main-line turn starts streaming before timestamp is assigned
    const outcome1 = await session.syncConversation([
      turn0,
      { id: "10:streaming:2", messageIndex: 2, prompt: "Second question", answer: "", sources: [], streaming: true },
    ], false, 10);
    assert.equal(outcome1, "snapshot");
    const snap1 = await session.ready();
    assert.equal(snap1.document.cards.length, 2);
    const liveCard = snap1.document.cards[1];
    assert.equal(liveCard.kind, "response");
    assert.equal(liveCard.status, "streaming");
    assert.equal(liveCard.importedTurn, "10:streaming:2");
    assert.deepEqual(liveCard.parents, ["llm:10:100"]);
    assert.deepEqual(focused, [liveCard.id]);
    // Visible in conversation 10, hidden in conversation 20
    assert.equal(conversationCards(snap1.document.cards, new Set(["10:100", "10:streaming:2"]), 10).length, 2);
    assert.equal(conversationCards(snap1.document.cards, new Set(["20:999"]), 20).length, 0);
    // Transient streaming card is NOT persisted on save
    await session.command({ type: "save" });
    assert.equal(savedDocs.at(-1)?.cards.length, 1);
    const savesBeforeDeltas = savedDocs.length;

    // 2. Streaming deltas update live via card event, handle timestamp appearing, and do not re-focus or save
    const outcome2 = await session.syncConversation([
      turn0,
      { id: "10:200", messageIndex: 2, prompt: "Second question", answer: "Part 1", sources: [], streaming: true },
    ], false, 10);
    assert.equal(outcome2, "card");
    const outcome3 = await session.syncConversation([
      turn0,
      { id: "10:200", messageIndex: 2, prompt: "Second question", answer: "Part 1 + Part 2", sources: [], streaming: true },
    ], false, 10);
    assert.equal(outcome3, "card");
    assert.equal(focused.length, 1);
    assert.equal(savedDocs.length, savesBeforeDeltas);
    assert.equal(cardUpdates.at(-1)?.id, liveCard.id);
    assert.equal(cardUpdates.at(-1)?.answer, "Part 1 + Part 2");

    // 3. Dragging the streaming card preserves its position without polluting disk/undo, and stop returns false (delegates to #llm-cancel)
    await session.command({ type: "move", positions: [{ id: liveCard.id, x: 512, y: 640 }] });
    assert.equal(savedDocs.length, savesBeforeDeltas);
    assert.equal(await session.command({ type: "stop", id: liveCard.id }), false);
    await assert.rejects(session.command({ type: "remove", ids: [liveCard.id] }), /请在论文对话中移除这条消息/);

    // 4. Completion promotes in place with same id and dragged coordinates, then persists
    const turn2 = { id: "10:200", messageIndex: 2, prompt: "Second question", answer: "Full second answer", sources: [] };
    const outcome4 = await session.syncConversation([turn0, turn2], false, 10);
    assert.equal(outcome4, "snapshot");
    const snapDone = await session.ready();
    assert.equal(snapDone.document.cards.length, 2);
    const promoted = snapDone.document.cards[1];
    assert.equal(promoted.id, liveCard.id);
    assert.equal(promoted.x, 512);
    assert.equal(promoted.y, 640);
    assert.equal(promoted.importedTurn, "10:200");
    assert.equal(promoted.status, "done");
    assert.equal(promoted.answer, "Full second answer");
    await session.command({ type: "save" });
    assert.equal(savedDocs.at(-1)?.cards.length, 2);
    assert.equal(savedDocs.at(-1)?.cards[1].id, liveCard.id);
    assert.ok(savesAfterSeed >= 1);

    // 5. Branch card streams answer live and stops via nativeJobs
    let branchStopped = false;
    const branchId = await session.submitNativeBranch([promoted.id], "Deep dive", undefined, 10, async () => ({ messageIndex: 4 }), () => {
      branchStopped = true;
    });
    assert.equal(await session.command({ type: "stop", id: branchId }), true);
    assert.equal(branchStopped, true);
    const branchDelta = await session.syncConversation([
      turn0,
      turn2,
      { id: "10:300", messageIndex: 4, prompt: "Deep dive", answer: "Branch streaming...", sources: [], streaming: true },
    ], false, 10);
    assert.equal(branchDelta, "card");
    assert.equal((await session.ready()).document.cards.find((card) => card.id === branchId)?.answer, "Branch streaming...");
    await session.syncConversation([
      turn0,
      turn2,
      { id: "10:300", messageIndex: 4, prompt: "Deep dive", answer: "Branch final answer", sources: [] },
    ], false, 10);
    const finalizedBranch = (await session.ready()).document.cards.find((card) => card.id === branchId);
    assert.equal(finalizedBranch?.status, "done");
    assert.equal(finalizedBranch?.nativeTurn, "10:300");
    assert.equal(finalizedBranch?.answer, "Branch final answer");

    // 6. Cancelled streaming main-line turn that disappears leaves no orphan card
    await session.syncConversation([
      turn0,
      turn2,
      { id: "10:300", messageIndex: 4, prompt: "Deep dive", answer: "Branch final answer", sources: [] },
      { id: "10:streaming:6", messageIndex: 6, prompt: "Aborted question", answer: "", sources: [], streaming: true },
    ], false, 10);
    assert.equal((await session.ready()).document.cards.length, 4);
    await session.syncConversation([
      turn0,
      turn2,
      { id: "10:300", messageIndex: 4, prompt: "Deep dive", answer: "Branch final answer", sources: [] },
    ], false, 10);
    assert.equal((await session.ready()).document.cards.length, 3);

    // 7. Partial (virtualized) conversation still promotes a finished streaming card
    await session.syncConversation([
      turn2,
      { id: "10:400", messageIndex: 6, prompt: "Virtualized Q", answer: "Partial stream...", sources: [], streaming: true },
    ], true, 10);
    const partialLive = (await session.ready()).document.cards.find((card) => card.prompt === "Virtualized Q");
    assert.equal(partialLive?.status, "streaming");
    assert.deepEqual(partialLive?.parents, [promoted.id]);
    await session.syncConversation([
      turn2,
      { id: "10:400", messageIndex: 6, prompt: "Virtualized Q", answer: "Virtualized final", sources: [] },
    ], true, 10);
    const partialDone = (await session.ready()).document.cards.find((card) => card.id === partialLive?.id);
    assert.equal(partialDone?.status, "done");
    assert.equal(partialDone?.importedTurn, "10:400");
    assert.equal(partialDone?.answer, "Virtualized final");

    // 8. Regenerating an existing response card overlays streaming in-place and clears cleanly even if text is unchanged
    await session.syncConversation([
      turn0,
      { id: "10:200", messageIndex: 2, prompt: "Second question", answer: "Regenerating...", sources: [], streaming: true },
    ], false, 10);
    assert.equal((await session.ready()).document.cards.find((card) => card.id === promoted.id)?.status, "streaming");
    assert.equal((await session.ready()).document.cards.find((card) => card.id === promoted.id)?.answer, "Regenerating...");
    await session.syncConversation([turn0, turn2], false, 10);
    assert.equal((await session.ready()).document.cards.find((card) => card.id === promoted.id)?.status, "done");
    assert.equal((await session.ready()).document.cards.find((card) => card.id === promoted.id)?.answer, "Full second answer");

    // 9. Crystallize streaming turn is suppressed before and after onSent, then permanently hidden
    const countBeforeNote = (await session.ready()).document.cards.length;
    await session.crystallize([promoted.id], 10, async (payload, onSent) => {
      await session.syncConversation([
        turn0,
        turn2,
        { id: "10:streaming:8", messageIndex: 8, prompt: payload.prompt, answer: "Drafting note...", sources: [], streaming: true },
      ], false, 10);
      assert.equal((await session.ready()).document.cards.length, countBeforeNote);
      onSent({ messageIndex: 8 });
      await session.syncConversation([
        turn0,
        turn2,
        { id: "10:500", messageIndex: 8, prompt: payload.prompt, answer: "More note...", sources: [], streaming: true },
      ], false, 10);
      assert.equal((await session.ready()).document.cards.length, countBeforeNote);
      return "Final note text";
    });
    await session.syncConversation([
      turn0,
      turn2,
      { id: "10:500", messageIndex: 8, prompt: "把上述阅读记录整理为中文笔记。用 Markdown 标题和列表梳理问题、结论、证据和待验证事项。", answer: "Final note text", sources: [] },
    ], false, 10);
    const finalSnap = await session.ready();
    assert.equal(finalSnap.document.cards.length, countBeforeNote);
    assert.ok(finalSnap.document.hiddenTurns?.includes("10:500"));
  } finally {
    await session.close();
  }
});

test("parentPaper and zoteroHost support standalone PDF attachments end to end", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zcanvas-standalone-"));
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;
  const previousPathUtils = (globalThis as { PathUtils?: unknown }).PathUtils;
  const previousIOUtils = (globalThis as { IOUtils?: unknown }).IOUtils;

  const imagePath = join(dataDir, "annotation.png");
  const imageBytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  await writeFile(imagePath, imageBytes);

  const regularPaper = {
    id: 100,
    key: "REG00100",
    libraryID: 1,
    deleted: false,
    isRegularItem: () => true,
    isAttachment: () => false,
    isPDFAttachment: () => false,
  };
  const deletedPaper = {
    id: 101,
    key: "DEL00101",
    libraryID: 1,
    deleted: true,
    isRegularItem: () => true,
    isAttachment: () => false,
    isPDFAttachment: () => false,
  };
  const relatedItemsOnPdf: unknown[] = [];
  let pdfSaved = 0;
  const standalonePdf = {
    id: 774,
    key: "3CQL4X72",
    libraryID: 1,
    parentID: false,
    parentItem: false,
    deleted: false,
    attachmentContentType: "application/pdf",
    attachmentFilename: "ase26-ArmGo.pdf",
    isRegularItem: () => false,
    isAttachment: () => true,
    isPDFAttachment: () => true,
    getDisplayTitle: () => "ase26-ArmGo",
    getCreators: () => { throw new Error("getCreators called on attachment"); },
    getField: () => { throw new Error("getField called on attachment"); },
    getNotes: () => { throw new Error("getNotes called on attachment"); },
    getCollections: () => [11, 22],
    addRelatedItem: (item: unknown) => { relatedItemsOnPdf.push(item); return true; },
    saveTx: async () => { pdfSaved++; },
  };
  const standaloneMarkdown = {
    id: 775,
    key: "MD000775",
    libraryID: 1,
    parentID: false,
    parentItem: false,
    deleted: false,
    attachmentContentType: "text/markdown",
    attachmentFilename: "notes.md",
    isRegularItem: () => false,
    isAttachment: () => true,
    isPDFAttachment: () => false,
  };
  const standaloneImage = {
    id: 776,
    key: "IMG00776",
    libraryID: 1,
    parentID: false,
    parentItem: false,
    deleted: false,
    attachmentContentType: "image/png",
    attachmentFilename: "figure.png",
    isRegularItem: () => false,
    isAttachment: () => true,
    isPDFAttachment: () => false,
  };
  const standaloneNote = {
    id: 777,
    key: "NOTE0777",
    libraryID: 1,
    parentID: false,
    parentItem: false,
    deleted: false,
    isRegularItem: () => false,
    isAttachment: () => false,
    isPDFAttachment: () => false,
  };
  const childPdfOfRegular = {
    id: 778,
    key: "CPDF0778",
    libraryID: 1,
    parentID: regularPaper.id,
    parentItem: regularPaper,
    deleted: false,
    isRegularItem: () => false,
    isAttachment: () => true,
    isPDFAttachment: () => true,
  };
  const childPdfOfDeleted = {
    id: 779,
    key: "DPDF0779",
    libraryID: 1,
    parentID: deletedPaper.id,
    parentItem: deletedPaper,
    deleted: false,
    isRegularItem: () => false,
    isAttachment: () => true,
    isPDFAttachment: () => true,
  };
  const annotationOnStandalone = {
    id: 780,
    key: "ANNO0780",
    libraryID: 1,
    parentID: standalonePdf.id,
    parentItem: standalonePdf,
    annotationType: "image",
    deleted: false,
    isRegularItem: () => false,
    isAttachment: () => false,
    isPDFAttachment: () => false,
  };
  const annotationOnChildPdf = {
    id: 781,
    key: "ANNO0781",
    libraryID: 1,
    parentID: childPdfOfRegular.id,
    parentItem: childPdfOfRegular,
    annotationType: "highlight",
    deleted: false,
    isRegularItem: () => false,
    isAttachment: () => false,
    isPDFAttachment: () => false,
  };

  const createdNotes: Array<{
    key: string;
    libraryID: number;
    parentID?: number;
    collections: number[];
    related: unknown[];
    html: string;
    saved: boolean;
  }> = [];

  class FakeNoteItem {
    id = 900 + createdNotes.length;
    key = `SAVED00${createdNotes.length + 1}`;
    libraryID = 1;
    parentID?: number;
    collections: number[] = [];
    related: unknown[] = [];
    html = "";
    saved = false;
    constructor(_type: string) {
      createdNotes.push(this);
    }
    setCollections(ids: number[]) {
      this.collections = [...ids];
    }
    addRelatedItem(item: unknown) {
      this.related.push(item);
      return true;
    }
    setNote(html: string) {
      this.html = html;
    }
    async saveTx() {
      this.saved = true;
    }
  }

  const byKey = new Map<string, unknown>([
    [standalonePdf.key, standalonePdf],
    [annotationOnStandalone.key, annotationOnStandalone],
  ]);

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
    read: async (path: string) => new Uint8Array(await readFile(path)),
    readUTF8: async (path: string) => readFile(path, "utf8"),
    stat: async (path: string) => stat(path),
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
    Item: FakeNoteItem,
    Libraries: {
      userLibraryID: 1,
      get: () => ({ libraryID: 1, libraryType: "user", editable: true }),
    },
    Items: {
      getByLibraryAndKeyAsync: async (_libraryID: number, key: string) => byKey.get(key) ?? false,
    },
    Annotations: {
      getCacheImagePath: () => imagePath,
    },
    PDFWorker: {
      renderAttachmentAnnotations: async () => {},
    },
  };

  const win = { ZoteroPane: { loadURI: () => {} } } as unknown as _ZoteroTypes.MainWindow;

  try {
    assert.equal(parentPaper(standalonePdf as unknown as Zotero.Item), standalonePdf);
    assert.equal(parentPaper(standaloneMarkdown as unknown as Zotero.Item), standaloneMarkdown);
    assert.equal(parentPaper(standaloneImage as unknown as Zotero.Item), undefined);
    assert.equal(parentPaper(standaloneNote as unknown as Zotero.Item), undefined);
    assert.equal(parentPaper(childPdfOfRegular as unknown as Zotero.Item), regularPaper);
    assert.equal(parentPaper(childPdfOfDeleted as unknown as Zotero.Item), undefined);
    assert.equal(parentPaper(annotationOnStandalone as unknown as Zotero.Item), standalonePdf);
    assert.equal(parentPaper(annotationOnChildPdf as unknown as Zotero.Item), regularPaper);

    const host = zoteroHost(standalonePdf as unknown as Zotero.Item, win);
    assert.equal(host.paper.title, "ase26-ArmGo");
    assert.equal(host.paper.authors, "");
    assert.equal(host.paper.year, "");
    assert.equal(host.paper.abstract, "");

    const anchor = makeAnchor(standalonePdf as unknown as Zotero.Item, 2, annotationOnStandalone.key, true);
    const encodedImage = await host.image(anchor);
    assert.equal(encodedImage, `data:image/png;base64,${Buffer.from(imageBytes).toString("base64")}`);

    const session = new CanvasSession(host);
    try {
      await session.addExcerpt({ quote: "Standalone PDF quote", anchor });
      const snapshot = await session.ready();
      assert.equal(snapshot.document.cards.length, 1);
      const savedFile = canvasFilePath(standalonePdf as unknown as Zotero.Item);
      const persisted = documentSchema.parse(JSON.parse(await readFile(savedFile, "utf8")));
      assert.equal(persisted.cards[0].quote, "Standalone PDF quote");

      const noteUri = await session.crystallize([snapshot.document.cards[0].id], 10, async () => "## Summary\n- Key finding");
      assert.equal(noteUri, "zotero://select/library/items/SAVED001");
      assert.equal(createdNotes.length, 1);
      assert.equal(createdNotes[0].parentID, undefined);
      assert.deepEqual(createdNotes[0].collections, [11, 22]);
      assert.deepEqual(createdNotes[0].related, [standalonePdf]);
      assert.equal(createdNotes[0].saved, true);
      assert.deepEqual(relatedItemsOnPdf, [createdNotes[0]]);
      assert.equal(pdfSaved, 1);
    } finally {
      await session.close();
    }
  } finally {
    (globalThis as Record<string, unknown>).Zotero = previousZotero;
    (globalThis as Record<string, unknown>).PathUtils = previousPathUtils;
    (globalThis as Record<string, unknown>).IOUtils = previousIOUtils;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("readerHooks injects and cleans up toolbar buttons on already-open standalone and regular readers without duplicates", async () => {
  const previousZotero = (globalThis as { Zotero?: unknown }).Zotero;

  class FakeElement {
    tagName: string;
    type = "";
    className = "";
    textContent = "";
    title = "";
    parentElement: FakeElement | null = null;
    children: FakeElement[] = [];
    attrs = new Map<string, string>();
    listeners = new Map<string, Array<() => void>>();
    classList = {
      contains: (name: string) => this.className.split(/\s+/).includes(name),
    };
    constructor(tagName: string) {
      this.tagName = tagName;
    }
    get childElementCount() {
      return this.children.length;
    }
    setAttribute(name: string, value: string) {
      this.attrs.set(name, value);
    }
    hasAttribute(name: string) {
      return this.attrs.has(name);
    }
    append(...nodes: FakeElement[]) {
      for (const node of nodes) {
        node.parentElement = this;
        this.children.push(node);
      }
    }
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }
    addEventListener(type: string, handler: () => void) {
      const handlers = this.listeners.get(type) ?? [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }
    click() {
      for (const handler of this.listeners.get("click") ?? []) handler();
    }
    querySelectorAll(selector: string): FakeElement[] {
      const attr = selector.match(/^\[([^\]]+)\]$/)?.[1];
      const found: FakeElement[] = [];
      const walk = (node: FakeElement) => {
        if (attr && node.hasAttribute(attr)) found.push(node);
        for (const child of node.children) walk(child);
      };
      walk(this);
      return found;
    }
  }

  function makeReaderDoc() {
    const root = new FakeElement("div");
    const customSections = new FakeElement("div");
    customSections.className = "custom-sections";
    root.append(customSections);
    return {
      customSections,
      createElement: (tag: string) => new FakeElement(tag),
      querySelector: (selector: string) => {
        if (selector === ".toolbar .end > .custom-sections" || selector === ".end > .custom-sections") {
          return customSections;
        }
        return root.querySelectorAll(selector)[0] ?? null;
      },
      querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    };
  }

  const standalonePdf = {
    id: 774,
    key: "3CQL4X72",
    libraryID: 1,
    parentID: false,
    parentItem: false,
    deleted: false,
    isRegularItem: () => false,
    isAttachment: () => true,
    isPDFAttachment: () => true,
  };
  const readerDoc = makeReaderDoc();
  const existingReader = {
    itemID: standalonePdf.id,
    _iframeWindow: { document: readerDoc },
    _initPromise: Promise.resolve(),
  };
  const handlers = new Map<string, (event: unknown) => void>();

  (globalThis as Record<string, unknown>).Zotero = {
    uiReadyPromise: Promise.resolve(),
    Items: {
      get: (id: number) => id === standalonePdf.id ? standalonePdf : false,
    },
    Reader: {
      _readers: [existingReader],
      registerEventListener: (type: string, handler: (event: unknown) => void) => {
        handlers.set(type, handler);
      },
      unregisterEventListener: (type: string) => {
        handlers.delete(type);
      },
    },
  };

  const opened: unknown[] = [];
  const dispose = readerHooks("test-plugin", (paper) => opened.push(paper), () => true);
  try {
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(readerDoc.customSections.children.length, 1);
    assert.equal(readerDoc.querySelectorAll("[data-zcanvas-toolbar-button]").length, 1);

    const renderToolbar = handlers.get("renderToolbar");
    assert.ok(renderToolbar);
    renderToolbar({
      reader: existingReader,
      doc: readerDoc,
      append: (button: FakeElement) => {
        const section = readerDoc.createElement("div");
        section.className = "section";
        section.append(button);
        readerDoc.customSections.append(section);
      },
    });
    assert.equal(readerDoc.querySelectorAll("[data-zcanvas-toolbar-button]").length, 1);

    readerDoc.querySelectorAll("[data-zcanvas-toolbar-button]")[0].click();
    assert.deepEqual(opened, [standalonePdf]);
  } finally {
    dispose();
    (globalThis as Record<string, unknown>).Zotero = previousZotero;
  }
  assert.equal(readerDoc.customSections.children.length, 0);
  assert.equal(readerDoc.querySelectorAll("[data-zcanvas-toolbar-button]").length, 0);
});
