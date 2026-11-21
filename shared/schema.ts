import { z } from "zod";

z.config({ jitless: true });

const id = z.string().min(1).max(100);
const position = z.object({ x: z.number(), y: z.number() });
export const viewportSchema = position.extend({ zoom: z.number().min(0.15).max(2) });
const pdfUri = /^zotero:\/\/open-pdf\/(?:library|groups\/\d+)\/items\/[A-Z0-9]{8}\?page=\d+(?:&annotation=[A-Z0-9]{8})?$/;
const itemUri = /^zotero:\/\/select\/(?:library|groups\/\d+)\/items\/[A-Z0-9]{8}$/;

export const anchorSchema = z.object({
  uri: z.string().regex(pdfUri),
  page: z.number().int().positive(),
  image: z.boolean().optional(),
});
export const referenceSchema = z.object({
  uri: z.string().regex(itemUri),
  title: z.string(),
  authors: z.string(),
  year: z.string(),
  abstract: z.string(),
});

export const cardSchema = position.extend({
  id, parents: z.array(id), title: z.string().max(500),
  kind: z.enum(["excerpt", "branch", "synthesis", "citation", "response"]),
  quote: z.string().max(50000).optional(),
  anchor: anchorSchema.optional(),
  sources: z.array(anchorSchema).max(30).optional(),
  importedTurn: id.optional(),
  nativeTurn: id.optional(),
  messageIndex: z.number().int().nonnegative().optional(),
  nativeBranch: z.number().int().positive().optional(),
  reference: referenceSchema.optional(),
  prompt: z.string().max(20000).optional(),
  answer: z.string().max(65000).optional(),
  error: z.string().max(1000).optional(),
  status: z.enum(["streaming", "done", "error", "stopped"]).optional(),
});

export const documentSchema = z.object({
  version: z.literal(1),
  cards: z.array(cardSchema).max(1000),
  viewport: viewportSchema,
  hiddenTurns: z.array(id).max(1000).optional(),
}).superRefine(({ cards }, context) => {
  const seen = new Set<string>();
  for (const card of cards) {
    if (seen.has(card.id) || new Set(card.parents).size !== card.parents.length
      || card.parents.some((parent) => !seen.has(parent))) {
      context.addIssue({ code: "custom", message: "画布引用图无效" });
      return;
    }
    seen.add(card.id);
  }
});

export const settingsSchema = z.object({
  provider: z.enum(["compatible", "anthropic", "ollama"]),
  endpoint: z.string().trim().max(2048),
  model: z.string().trim().max(200),
});

export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("askConversation"), key: z.number().int(), prompt: z.string().trim().min(1).max(20000) }),
  z.object({
    type: z.literal("openComposer"), request: id, parents: z.array(id).max(50),
    quote: z.string().max(50000).optional(), source: z.string().max(500).optional(), draft: z.string().max(20000),
    anchor: z.object({ left: z.number(), top: z.number(), bottom: z.number() }).optional(),
  }),
  z.object({ type: z.literal("closeComposer"), request: id }),
  z.object({ type: z.literal("readCitedAnswer"), id }),
  z.object({
    type: z.literal("openAnswerCitation"), prefix: id, index: z.number().int().nonnegative(),
    anchor: z.object({ left: z.number(), right: z.number(), top: z.number(), bottom: z.number() }),
  }),
  z.object({ type: z.literal("closeAnswerCitation"), prefix: id }),
  z.object({ type: z.literal("branch"), parents: z.array(id).max(50), prompt: z.string().trim().min(1).max(20000), quote: z.string().max(50000).optional() }),
  z.object({ type: z.literal("move"), positions: z.array(position.extend({ id })).max(1000) }),
  z.object({ type: z.literal("viewport"), viewport: viewportSchema }),
  z.object({ type: z.literal("remove"), ids: z.array(id).max(1000) }),
  z.object({ type: z.literal("undo") }),
  z.object({ type: z.literal("redo") }),
  z.object({ type: z.literal("retry"), id }),
  z.object({ type: z.literal("stop"), id }),
  z.object({ type: z.literal("source"), id, index: z.number().int().nonnegative().optional() }),
  z.object({ type: z.literal("image"), id }),
  z.object({ type: z.literal("search"), query: z.string().trim().min(1).max(200) }),
  z.object({ type: z.literal("cite"), uri: z.string().regex(itemUri) }),
  z.object({ type: z.literal("crystallize"), ids: z.array(id).min(1).max(50) }),
  z.object({ type: z.literal("settings"), settings: settingsSchema, key: z.string().max(5000).optional() }),
  z.object({ type: z.literal("save") }),
]);
export const requestSchema = z.object({ channel: z.literal("zcanvas:request"), id, command: commandSchema });

export type Anchor = z.infer<typeof anchorSchema>;
export type Reference = z.infer<typeof referenceSchema>;
export type Card = z.infer<typeof cardSchema>;
export type CanvasDocument = z.infer<typeof documentSchema>;
export type Settings = z.infer<typeof settingsSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Position = z.infer<typeof position>;
export type Excerpt = { quote?: string; anchor: Anchor };
export type ConversationTurn = {
  id: string;
  prompt: string;
  answer: string;
  sources: Anchor[];
  messageIndex?: number;
  stopped?: boolean;
  branchID?: string;
  quotedTexts?: string[];
};
export type CitedAnswer = { answer: string; prefix: string; count: number };
export type Snapshot = {
  document: CanvasDocument;
  paper: Reference;
  conversationKey?: number;
  undo: boolean;
  redo: boolean;
  settings: Settings & { hasKey: boolean };
  saved: boolean;
  saveError?: string;
};
export type Event =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "card"; card: Card }
  | { type: "focus"; id: string }
  | { type: "composerClosed"; request: string; draft: string }
  | { type: "citationClosed"; prefix: string; index: number; restoreFocus: boolean };
export type Reply = {
  ready: Snapshot;
  openComposer: boolean;
  readCitedAnswer: CitedAnswer | null;
  branch: string;
  search: Reference[];
  image: string | null;
  crystallize: string;
};
export type Result<T extends Command["type"]> = T extends keyof Reply ? Reply[T] : void;

export const defaultSettings: Settings = { provider: "compatible", endpoint: "https://api.openai.com/v1", model: "" };
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
