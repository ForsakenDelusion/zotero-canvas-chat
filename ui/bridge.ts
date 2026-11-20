import type { Command, Event, Result } from "../shared/schema";
import { hostColors, type CanvasTheme } from "../shared/theme";

export interface Bridge {
  call<C extends Command>(command: C): Promise<Result<C["type"]>>;
  subscribe(listener: (event: Event) => void): () => void;
}

function remote(port: MessagePort): Bridge {
  let sequence = 0;
  let pendingFocus: Extract<Event, { type: "focus" }> | undefined;
  const handlers = new Set<(event: Event) => void>();
  const pending = new Map<string, {
    resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;
  }>();
  port.onmessage = (message) => {
    const { data } = message as MessageEvent;
    if (data.theme) {
      const theme = data.theme as CanvasTheme;
      const root = document.documentElement;
      root.dataset.theme = theme.dark ? "dark" : "light";
      for (const name of Object.keys(hostColors) as (keyof typeof hostColors)[]) {
        const color = theme.colors[name];
        if (color && CSS.supports("color", color)) root.style.setProperty(name, color);
        else root.style.removeProperty(name);
      }
      return;
    }
    if (data.event) {
      if (!handlers.size && data.event.type === "focus") pendingFocus = data.event;
      for (const handler of handlers) handler(data.event);
      return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    clearTimeout(request.timer);
    if (data.ok) request.resolve(data.value);
    else request.reject(new Error(data.error || "Zotero 操作失败。"));
  };
  return {
    call<C extends Command>(command: C): Promise<Result<C["type"]>> {
      return new Promise((resolve, reject) => {
        const id = String(++sequence);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(command.type === "ready" ? "无法连接 Zotero 阅读画布。" : "操作超时，请重试。"));
        }, command.type === "ready" ? 8000 : 200_000);
        pending.set(id, { resolve: (value) => resolve(value as Result<C["type"]>), reject, timer });
        port.postMessage({ channel: "zcanvas:request", id, command });
      });
    },
    subscribe(listener) {
      handlers.add(listener);
      if (pendingFocus) {
        listener(pendingFocus);
        pendingFocus = undefined;
      }
      return () => { handlers.delete(listener); };
    },
  };
}

export async function createBridge(): Promise<Bridge> {
  if (window.parent !== window) return new Promise((resolve, reject) => {
    const connection = window.location.hash.slice(1);
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("无法连接 Zotero 阅读画布。"));
    }, 8000);
    const receive = (event: MessageEvent) => {
      if (!connection.startsWith("zcanvas:") || event.data !== connection || event.ports.length !== 1) return;
      if (event.source !== null && event.source !== window.parent) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
      resolve(remote(event.ports[0]));
    };
    window.addEventListener("message", receive);
  });
  if (import.meta.env.DEV) return (await import("./demo")).demoBridge();
  throw new Error("请从 Zotero 打开阅读画布。");
}
