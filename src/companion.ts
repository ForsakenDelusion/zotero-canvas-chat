import { z } from "zod";
import type { Message } from "../shared/graph";
import { errorMessage } from "../shared/schema";

export const turnSchema = z.object({
  itemID: z.number().int().positive(),
  conversationKey: z.number().int(),
  timestamp: z.number().int().positive(),
  question: z.string().trim().max(20000),
  answer: z.string().trim().min(1).max(65000),
  sources: z.array(z.object({
    attachmentID: z.number().int().positive(), pageIndex: z.number().int().nonnegative(),
  })).max(30),
});

type StreamRequest = { system: string; messages: Message[]; signal: AbortSignal };
type CompanionModel = {
  version: number;
  stream(request: StreamRequest, onDelta: (text: string) => void): Promise<void>;
  openPaper?(itemID: number): Promise<void>;
};
type CompanionGlobals = typeof Zotero & {
  LLMForZotero?: { api?: { canvas?: CompanionModel }; data?: { standaloneWindow?: Window } };
  ZoteroCanvasChat?: {
    version: 2;
    acceptTurn(input: unknown): Promise<void>;
    mountPaper(itemID: number, container: Element, onDetach: () => void): () => void;
  };
};

export const companionGlobals = () => Zotero as CompanionGlobals;

function model() {
  const api = companionGlobals().LLMForZotero?.api?.canvas;
  return api?.version === 1 && typeof api.stream === "function" ? api : undefined;
}

export const companionAvailable = () => !!model();

export async function* companionStream(request: StreamRequest): AsyncGenerator<string> {
  const api = model();
  if (!api) throw new Error("请在画布的模型设置中配置 API 模型。");
  let text = "";
  let finished = false;
  let failure: string | undefined;
  let wake: (() => void) | undefined;
  const notify = () => wake?.();
  request.signal.addEventListener("abort", notify, { once: true });
  void Promise.resolve().then(() => api.stream(request, (delta) => {
    if (request.signal.aborted) return;
    text = (text + delta).slice(0, 65000);
    notify();
  })).catch((error: unknown) => { failure = errorMessage(error); }).finally(() => {
    finished = true;
    notify();
  });
  try {
    while (!request.signal.aborted) {
      if (text) {
        const chunk = text;
        text = "";
        yield chunk;
        continue;
      }
      if (failure !== undefined) throw new Error(failure);
      if (finished) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    request.signal.removeEventListener("abort", notify);
  }
}
