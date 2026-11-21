import { CanvasSession } from "../src/session";
import type { Bridge } from "./bridge";
import type { CanvasDocument, Command, Reference, Result } from "../shared/schema";

const paper: Reference = {
  uri: "zotero://select/library/items/PAPER001",
  title: "Attention as Information Routing",
  authors: "Lin & Rivera",
  year: "2024",
  abstract: "A reading example about attention as a differentiable routing operation.",
};
const reference: Reference = {
  uri: "zotero://select/library/items/PAPER002",
  title: "A Survey of Sparse Attention",
  authors: "Chen et al.",
  year: "2025",
  abstract: "Design choices in sparse attention and their computational trade-offs.",
};
const example: CanvasDocument = {
  version: 1,
  viewport: { x: 45, y: 105, zoom: 0.87 },
  cards: [
    {
      id: "excerpt", parents: [], x: 0, y: 115, kind: "excerpt", title: "注意力是可微分的路由",
      quote: "The attention weights act as a soft routing policy: each token receives a mixture of values weighted by its affinity to other tokens.",
      anchor: { uri: "zotero://open-pdf/library/items/ATTACH01?page=4", page: 4 },
    },
    {
      id: "explain", parents: ["excerpt"], x: 410, y: 0, kind: "branch", title: "通俗解释",
      prompt: "为什么可以说 attention 在做「信息路由」？", status: "done",
      answer: "每个 token 都在问：**我现在需要从谁那里取信息？**\n\n查询向量决定取谁的信息，注意力权重决定各来源占多少，值向量决定实际传递的内容。",
    },
    {
      id: "math", parents: ["excerpt"], x: 410, y: 290, kind: "branch", title: "数学推导",
      prompt: "写出权重的计算公式。", status: "done",
      answer: "$$\\alpha_{ij}=\\operatorname{softmax}_j\\!\\left(\\frac{q_i k_j^\\top}{\\sqrt{d_k}}\\right)$$\n\n$\\alpha_{ij}$ 是 token $i$ 从位置 $j$ 读取信息的权重。",
    },
    {
      id: "merge", parents: ["explain", "math"], x: 820, y: 125, kind: "synthesis", title: "连接直觉与公式",
      prompt: "将两种解释汇聚为一条阅读结论。", status: "done",
      answer: "注意力先算出各来源的**相关性**，再按归一化权重混合信息。路由可以随输入变化，因此同一 token 在不同语境里会从不同位置读信息。",
    },
  ],
};

export function demoBridge(): Bridge {
  const read = () => localStorage.getItem("zcanvas-demo-v1");
  const session = new CanvasSession({
    paper,
    load: async () => JSON.parse(read() || "null") ?? example,
    save: async (document) => { localStorage.setItem("zcanvas-demo-v1", JSON.stringify(document)); },
    image: async () => null,
    open() { window.dispatchEvent(new Event("zcanvas:demo-source")); },
    search: async (query) => reference.title.toLowerCase().includes(query.toLowerCase()) ? [reference] : [],
    reference: async () => reference,
    note: async (text, sources) => {
      localStorage.setItem("zcanvas-demo-note", JSON.stringify({ text, sources }));
      return "zotero://select/library/items/DEMONOTE";
    },
  });
  return {
    async call<C extends Command>(command: C): Promise<Result<C["type"]>> {
      if (command.type === "crystallize") {
        return await session.crystallize(command.ids, 0, async (payload) => `### 阅读笔记\n\n${payload.prompt}`) as Result<C["type"]>;
      }
      return await session.command(command) as Result<C["type"]>;
    },
    subscribe: (listener) => session.subscribe(listener),
  };
}
