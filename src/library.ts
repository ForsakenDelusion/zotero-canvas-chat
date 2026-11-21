import { strFromU8, strToU8, unzlibSync, zlibSync } from "fflate";
import { documentSchema, type Anchor, type CanvasDocument } from "../shared/schema";
import type { CanvasHost } from "./session";

const storageTag = "_zcanvas_data";
const marker = "ZCANVAS1:";
const encode = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  }
  return btoa(binary);
};
const escape = (text: string) => text.replace(/[&<>"']/g,
  (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);

export function itemPath(item: Zotero.Item) {
  const library = Zotero.Libraries.get(item.libraryID);
  const scope = library && library.libraryType === "group" ? `groups/${library.libraryTypeID}` : "library";
  return `${scope}/items/${item.key}`;
}

export function makeAnchor(attachment: Zotero.Item, pageIndex: number, annotationKey?: string, image?: boolean): Anchor {
  const page = pageIndex + 1;
  return {
    page, image,
    uri: `zotero://open-pdf/${itemPath(attachment)}?page=${page}${annotationKey ? `&annotation=${annotationKey}` : ""}`,
  };
}

export function parentPaper(item?: Zotero.Item | false): Zotero.Item | undefined {
  if (!item || item.deleted) return;
  const parent = item.isRegularItem() ? item : item.parentItem;
  return parent?.isRegularItem() && !parent.deleted ? parent : undefined;
}

function reference(item: Zotero.Item) {
  return {
    uri: `zotero://select/${itemPath(item)}`,
    title: String(item.getDisplayTitle()).replace(/<\/?(?:i|b|sub|sup|span)[^>]*>/gi, ""),
    authors: item.getCreators().map((creator) => [creator.firstName, creator.lastName].filter(Boolean).join(" ")).join(", "),
    year: String(item.getField("date")).match(/\b\d{4}\b/)?.[0] ?? "",
    abstract: String(item.getField("abstractNote")).slice(0, 20000),
  };
}

function storage(paper: Zotero.Item) {
  let baseline: string | undefined;
  function current() {
    const notes = Zotero.Items.get(paper.getNotes()).filter((note) => note.hasTag(storageTag) && !note.deleted);
    if (notes.length > 1) throw new Error("找到多条画布数据笔记。请先在 Zotero 中处理同步冲突。");
    return notes[0];
  }
  return {
    async load() {
      const note = current();
      if (!note) return null;
      baseline = note.getNote();
      const encoded = baseline.match(/ZCANVAS1:([A-Za-z0-9+/=]+)/)?.[1];
      if (!encoded) throw new Error("画布数据笔记格式无效。");
      try {
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        return documentSchema.parse(JSON.parse(strFromU8(unzlibSync(bytes))));
      } catch {
        throw new Error("无法读取画布数据笔记，请检查它是否损坏。");
      }
    },
    async save(document: CanvasDocument) {
      const library = Zotero.Libraries.get(paper.libraryID);
      if (!library || !library.editable) throw new Error("当前文库为只读。");
      let note = current();
      if (note?.getNote() !== baseline) throw new Error("画布数据在 Zotero 中已更改。请重启 Zotero 后查看最新版本。");
      if (!note && !document.cards.length && !document.hiddenTurns?.length) return;
      const payload = encode(zlibSync(strToU8(JSON.stringify(document)), { level: 6 }));
      if (!note) {
        note = new Zotero.Item("note");
        note.libraryID = paper.libraryID;
        note.parentID = paper.id;
        note.addTag(storageTag);
      }
      note.setNote(`<h1>Canvas Chat · 画布数据</h1><p>${marker}${payload}</p>`);
      try {
        await note.saveTx();
        baseline = note.getNote();
      } catch {
        if (note.id && baseline) note.setNote(baseline);
        throw new Error("Zotero 无法保存画布数据。");
      }
    },
  };
}

function noteBody(text: string) {
  const blocks: string[] = [];
  let list: { type: "ol" | "ul"; items: string[] } | undefined;
  function finishList() {
    if (!list) return;
    blocks.push(`<${list.type}>${list.items.join("")}</${list.type}>`);
    list = undefined;
  }
  for (const line of text.split(/\r?\n/)) {
    const bullet = line.match(/^\s*([-*+]|\d+[.)])\s+(.+)$/);
    if (bullet) {
      const type = /^\d/.test(bullet[1]) ? "ol" : "ul";
      if (list?.type !== type) {
        finishList();
        list = { type, items: [] };
      }
      list.items.push(`<li><p>${escape(bullet[2])}</p></li>`);
      continue;
    }
    finishList();
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      blocks.push(`<h${level}>${escape(heading[2])}</h${level}>`);
    } else if (line.trim()) blocks.push(`<p>${escape(line)}</p>`);
  }
  finishList();
  return blocks.join("");
}

export function zoteroHost(paper: Zotero.Item, win: _ZoteroTypes.MainWindow): CanvasHost {
  async function lookup(uri: string) {
    const url = new URL(uri);
    const segments = url.pathname.split("/");
    const libraryID = segments[1] === "groups"
      ? Zotero.Groups.get(Number(segments[2]))?.libraryID : Zotero.Libraries.userLibraryID;
    if (paper.libraryID !== libraryID) throw new Error("引用超出当前文库。");
    return Zotero.Items.getByLibraryAndKeyAsync(libraryID, segments.at(-1)!);
  }
  return {
    paper: reference(paper),
    ...storage(paper),
    async image(anchor) {
      const attachment = await lookup(anchor.uri);
      if (!attachment || attachment.parentID !== paper.id || !attachment.isPDFAttachment()) return null;
      const key = new URL(anchor.uri).searchParams.get("annotation");
      if (!key) return null;
      const annotation = await Zotero.Items.getByLibraryAndKeyAsync(attachment.libraryID, key);
      if (!annotation || annotation.parentID !== attachment.id || annotation.annotationType !== "image") return null;
      const path = Zotero.Annotations.getCacheImagePath(annotation);
      if (!await IOUtils.exists(path)) await Zotero.PDFWorker.renderAttachmentAnnotations(attachment.id, true);
      if (!await IOUtils.exists(path)) return null;
      const info = await IOUtils.stat(path);
      if ((info.size ?? 0) > 5_000_000) throw new Error("PDF 区域截图超出 5 MB。请尝试缩小所选区域。");
      return `data:image/png;base64,${encode(await IOUtils.read(path))}`;
    },
    open(uri) { win.ZoteroPane.loadURI(uri); },
    async search(query) {
      const search = Object.assign(new Zotero.Search(), { libraryID: paper.libraryID });
      search.addCondition("quicksearch-titleCreatorYear", "contains", query);
      const items = await Zotero.Items.getAsync(await search.search());
      return items.filter((item) => item.isRegularItem() && !item.deleted && item.id !== paper.id)
        .slice(0, 20).map(reference);
    },
    async reference(uri) {
      const item = await lookup(uri);
      if (!item || !item.isRegularItem() || item.deleted) throw new Error("找不到这篇文献。");
      return reference(item);
    },
    async note(text, sources) {
      const links = sources.map(({ label, uri }) => `<li><a href="${escape(uri)}">${escape(label)}</a></li>`).join("");
      const note = Object.assign(new Zotero.Item("note"), { libraryID: paper.libraryID });
      note.parentID = paper.id;
      note.setNote(`<h1>Canvas Chat · 阅读笔记</h1>${noteBody(text)}${links ? `<h2>来源</h2><ul>${links}</ul>` : ""}`);
      await note.saveTx();
      return `zotero://select/${itemPath(note)}`;
    },
  };
}
