import assert from "node:assert/strict";
import test from "node:test";
import { ancestors, conversationCards, emptyDocument } from "../shared/graph.ts";
import { readNativePrompt } from "../shared/question.ts";
import { documentSchema, type CanvasDocument, type Reference } from "../shared/schema.ts";
import { CanvasSession, initialSettings } from "../src/session.ts";

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
    getSettings: initialSettings,
    setSettings: () => {},
    generate: async function* () {},
    controller: () => new AbortController(),
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
    let outbound = "";
    await session.submitNativeBranch(["existing-response"], "Why?", "A selected phrase", 20, async (text) => { outbound = text; }, () => {});
    assert.match(outbound, /A selected phrase/);
    assert.match(outbound, /Updated original reply/);
    const { branchID, question } = readNativePrompt(outbound);
    assert.ok(branchID);
    assert.equal(question, "Why?");
    await session.syncConversation([{ id: "20:300", branchID, prompt: question, answer: "Native answer", sources: [] }], true);
    const native = (await session.ready()).document.cards;
    assert.equal(native.filter((card) => card.importedTurn).length, 2);
    assert.deepEqual(native.find((card) => card.id === branchID)?.parents, ["existing-response"]);
    assert.equal(native.find((card) => card.id === branchID)?.answer, "Native answer");
    assert.equal(native.find((card) => card.id === branchID)?.status, "done");
    assert.ok(conversationCards(native, new Set(["20:300"]), 20).some((card) => card.id === branchID));
  } finally {
    await session.close();
  }
});
