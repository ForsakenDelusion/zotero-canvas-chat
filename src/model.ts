import type { Message } from "../shared/graph";
import type { Settings } from "../shared/schema";

export function modelEndpoint(settings: Settings): string {
  let url: URL;
  try {
    url = new URL(settings.endpoint.trim());
  } catch {
    throw new Error("请输入有效的模型服务地址。");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error("模型地址须使用 HTTPS。本机服务可使用 HTTP，地址无需带凭据或参数。");
  }
  const route = settings.provider === "anthropic" ? "/messages" : "/chat/completions";
  let path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(route)) {
    if (!path && settings.provider !== "compatible") path = "/v1";
    url.pathname = `${path}${route}`;
  }
  return url.href;
}

type StreamInput = { system: string; messages: Message[]; signal: AbortSignal };

export async function* modelStream(
  settings: Settings, key: string, input: StreamInput, fetcher: typeof fetch,
): AsyncGenerator<string> {
  if (!settings.model.trim()) throw new Error("请先在模型设置中填写模型名称。");
  const anthropic = settings.provider === "anthropic";
  if (anthropic && !key) throw new Error("请先在模型设置中填写 Anthropic API Key。");
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (anthropic) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (key) headers.Authorization = `Bearer ${key}`;
  const messages = input.messages.map(({ role, text, images }) => ({
    role,
    content: images?.length ? [
      { type: "text", text },
      ...images.map((image) => anthropic ? {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: image.slice(image.indexOf(",") + 1) },
      } : { type: "image_url", image_url: { url: image } }),
    ] : text,
  }));
  const body = anthropic
    ? { model: settings.model, max_tokens: 4096, stream: true, system: input.system, messages }
    : { model: settings.model, stream: true, messages: [{ role: "system", content: input.system }, ...messages] };
  const response = await fetcher(modelEndpoint(settings), {
    method: "POST", headers, body: JSON.stringify(body), signal: input.signal,
    redirect: "error", credentials: "omit", cache: "no-store",
  });
  if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}。请检查地址、密钥和模型名称。`);
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
    throw new Error("模型服务没有返回流式回答。请检查服务地址和协议。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let hasFinishReason = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() + "\n\n" : decoder.decode(value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") return;
        const chunk = JSON.parse(data);
        if (chunk.type === "error" || chunk.error) throw new Error("模型服务在生成时返回错误。");
        if (chunk.type === "message_stop") return;
        const choice = chunk.choices?.[0];
        const text = anthropic
          ? (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta" ? chunk.delta.text : null)
          : choice?.delta?.content;
        if (choice?.finish_reason) hasFinishReason = true;
        if (typeof text === "string" && text) yield text;
      }
      if (done) break;
      if (buffer.length > 1_000_000) throw new Error("模型服务返回的事件超出大小限制。");
    }
    if (!hasFinishReason) throw new Error("模型连接提前中断。可重试此卡片。");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
