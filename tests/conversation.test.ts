import assert from "node:assert/strict";
import test from "node:test";
import { ancestors, conversationCards, emptyDocument } from "../shared/graph.ts";
import { readNativePrompt } from "../shared/question.ts";
import { documentSchema, settingsSchema, type CanvasDocument, type Reference, type Settings } from "../shared/schema.ts";
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
    await session.syncConversation([{ ...earlier, answer: "x".repeat(64500) }, later]);
    await session.submitNativeBranch(["existing-response"], "Why?", "A selected phrase", 20, async (text) => { outbound = text; }, () => {});
    assert.match(outbound, /本次追问选中的文字：\nA selected phrase/);
    assert.match(outbound, /Updated original reply/);
    assert.ok(outbound.indexOf("A selected phrase") < outbound.indexOf("Earlier question"));
    const { branchID, question } = readNativePrompt(outbound);
    assert.ok(branchID);
    assert.equal(question, "Why?");
    await session.syncConversation([{ id: "20:300", branchID, prompt: question, answer: "Native answer", sources: [] }], true);
    const native = (await session.ready()).document.cards;
    assert.equal(native.filter((card) => card.importedTurn).length, 2);
    assert.deepEqual(native.find((card) => card.id === branchID)?.parents, ["existing-response"]);
    assert.equal(native.find((card) => card.id === branchID)?.answer, "Native answer");
    assert.equal(native.find((card) => card.id === branchID)?.status, "done");
    assert.ok(conversationCards(native, new Set(["20:300"]), 20, new Set([branchID])).some((card) => card.id === branchID));
    await session.submitNativeBranch(["existing-response"], "Explain this", undefined, 20, async (text) => { outbound = text; }, () => {});
    assert.match(outbound, /本次追问的来源卡片：\n\n### #2 Later question[\s\S]*Updated original reply/);
    assert.ok(outbound.indexOf("Updated original reply") < outbound.indexOf("Earlier question"));
    await session.syncConversation([{
      id: "20:301", branchID: readNativePrompt(outbound).branchID,
      prompt: "Explain this", answer: "Explanation", sources: [],
    }], true);

    const oldTail = { id: "10:400", prompt: "Discarded question", answer: "Discarded answer", sources: [] };
    await session.syncConversation([earlier, later, oldTail]);
    const tailID = (await session.ready()).document.cards.find((card) => card.importedTurn === oldTail.id)!.id;
    await session.submitNativeBranch([tailID], "Discarded follow-up", undefined, 10, async (text) => { outbound = text; }, () => {});
    const discardedBranch = readNativePrompt(outbound).branchID!;
    const oldBranch = { id: "10:500", branchID: discardedBranch, prompt: "Discarded follow-up", answer: "Follow-up answer", sources: [] };
    await session.syncConversation([earlier, later, oldTail, oldBranch]);
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

test("settings updates validate endpoints, reset keys on provider change, and reject removed providers", async () => {
  const paper: Reference = {
    uri: "zotero://select/library/items/ABCDEFGH",
    title: "Fixture", authors: "", year: "", abstract: "",
  };
  let stored: Settings & { hasKey: boolean } = { ...initialSettings(), hasKey: true };
  let lastKey: string | undefined;
  const session = new CanvasSession({
    paper,
    load: async () => null,
    save: async () => {},
    getSettings: () => stored,
    setSettings(settings, key) {
      lastKey = key;
      stored = { ...settings, hasKey: key === undefined ? stored.hasKey : Boolean(key) };
    },
    generate: async function* () {},
    controller: () => new AbortController(),
    image: async () => null,
    open: () => {},
    search: async () => [],
    reference: async () => paper,
    note: async () => "",
  });
  try {
    assert.equal(settingsSchema.safeParse({ provider: "llm-for-zotero", endpoint: "", model: "" }).success, false);
    await session.command({
      type: "settings",
      settings: { provider: "compatible", endpoint: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    });
    assert.equal(lastKey, undefined);
    assert.equal((await session.ready()).settings.hasKey, true);

    await session.command({
      type: "settings",
      settings: { provider: "anthropic", endpoint: "https://api.anthropic.com/v1", model: "claude-sonnet-4-20250514" },
    });
    assert.equal(lastKey, "");
    assert.equal((await session.ready()).settings.hasKey, false);

    await assert.rejects(() => session.command({
      type: "settings",
      settings: { provider: "compatible", endpoint: "http://example.com/v1", model: "bad" },
    }), /HTTPS/);
  } finally {
    await session.close();
  }
});
