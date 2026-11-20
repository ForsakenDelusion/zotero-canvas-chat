import assert from "node:assert/strict";
import test from "node:test";
import { ancestors } from "../shared/graph.ts";
import type { CanvasDocument, Card } from "../shared/schema.ts";
import { organizeCards } from "../ui/layout.ts";

function card(id: string, parents: string[], text: string): Card {
  return { id, parents, x: 0, y: 0, kind: "excerpt", title: id, quote: text };
}

test("a synthesis sees its shared ancestor once and excludes unselected siblings", () => {
  const document: CanvasDocument = {
    version: 1,
    cards: [
      card("root", [], "method"),
      card("left", ["root"], "assumptions"),
      card("unselected", ["root"], "other"),
      card("right", ["root"], "results"),
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
  };

  assert.deepEqual(ancestors(document, ["left", "right"]).map((entry) => entry.id), [
    "root", "left", "right",
  ]);
});

test("organizing puts the conversation in order and spaces measured branches and merges", () => {
  const cards = [
    { id: "excerpt", parents: [], width: 320, height: 110 },
    { id: "first", parents: [], importedTurn: "first", width: 350, height: 370 },
    { id: "second", parents: ["first"], importedTurn: "second", width: 320, height: 200 },
    { id: "later-branch", parents: ["second"], width: 330, height: 180 },
    { id: "earlier-branch", parents: ["first"], width: 400, height: 500 },
    { id: "merge", parents: ["earlier-branch", "later-branch"], width: 360, height: 290 },
  ];
  const layout = organizeCards(cards);
  const [excerpt, first, second, laterBranch, earlierBranch, merge] = layout;

  assert.deepEqual(layout.map((position) => position.id), cards.map((entry) => entry.id));
  assert.equal(first.x, second.x);
  assert.ok(second.y > first.y + cards[1].height);
  assert.ok(excerpt.y > second.y + cards[2].height);
  assert.equal(earlierBranch.x, laterBranch.x);
  assert.equal(earlierBranch.y, first.y);
  assert.ok(earlierBranch.x > first.x + cards[1].width);
  assert.ok(laterBranch.y > earlierBranch.y + cards[4].height);
  assert.ok(merge.x > earlierBranch.x + cards[4].width);
  assert.ok(merge.y >= laterBranch.y);
});
