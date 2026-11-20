import type { Card, Position } from "../shared/schema";

type LayoutCard = Pick<Card, "id" | "parents" | "importedTurn"> & { width: number; height: number };

export function organizeCards(cards: LayoutCard[]): (Position & { id: string })[] {
  const rankById = new Map<string, number>();
  const columns: LayoutCard[][] = [];
  for (const card of cards) {
    const rank = card.importedTurn ? 0 : Math.max(0, ...card.parents.map((id) => rankById.get(id)! + 1));
    rankById.set(card.id, rank);
    (columns[rank] ??= []).push(card);
  }

  const positions = new Map<string, Position & { id: string }>();
  let x = 0;
  for (const [rank, column] of columns.entries()) {
    const ordered = column.map((card) => ({
      card,
      preferredY: rank ? Math.max(...card.parents.map((id) => positions.get(id)!.y)) : 0,
    })).sort((first, second) =>
      Number(Boolean(second.card.importedTurn)) - Number(Boolean(first.card.importedTurn)) ||
      first.preferredY - second.preferredY);
    let bottom = 0;
    for (const { card, preferredY } of ordered) {
      const y = Math.max(bottom, preferredY);
      positions.set(card.id, { id: card.id, x, y });
      bottom = y + card.height + 58;
    }
    x += Math.max(...column.map((card) => card.width)) + 100;
  }

  return cards.map((card) => positions.get(card.id)!);
}
