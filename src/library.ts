import { strFromU8, unzlibSync } from "fflate";
import { documentSchema, type Anchor, type CanvasDocument } from "../shared/schema";
import type { CanvasHost } from "./session";

const storageTag = "_zcanvas_data";
const storageDir = "zotero-canvas-chat";
const fileLocks = new Map<string, Promise<unknown>>();
const standaloneAttachmentTypes = new Set([
  "application/pdf",
  "text/markdown",
  "text/x-markdown",
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const standaloneAttachmentExtensions = /\.(?:pdf|md|markdown|html?|txt|docx)$/i;
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

function standalonePaperAttachment(item?: Zotero.Item | false): boolean {
  if (!item || item.deleted || item.parentID) return false;
  if (typeof item.isAttachment === "function" ? !item.isAttachment() : !item.isPDFAttachment?.()) return false;
  if (item.isPDFAttachment?.()) return true;
  const contentType = String(item.attachmentContentType ?? "").trim().toLowerCase();
  if (standaloneAttachmentTypes.has(contentType)) return true;
  const filename = String((item as Zotero.Item & { attachmentFilename?: string }).attachmentFilename ?? "").trim();
  return standaloneAttachmentExtensions.test(filename);
}

export function parentPaper(item?: Zotero.Item | false): Zotero.Item | undefined {
  if (!item || item.deleted) return;
  if (item.isRegularItem()) return item;
  if (standalonePaperAttachment(item)) return item;
  const parent = item.parentItem;
  if (!parent || parent.deleted) return;
  if (parent.isRegularItem() || standalonePaperAttachment(parent)) return parent;
  const grandparent = parent.parentItem;
  return grandparent && !grandparent.deleted && grandparent.isRegularItem() ? grandparent : undefined;
}

function reference(item: Zotero.Item) {
  const regular = item.isRegularItem();
  return {
    uri: `zotero://select/${itemPath(item)}`,
    title: String(item.getDisplayTitle()).replace(/<\/?(?:i|b|sub|sup|span)[^>]*>/gi, ""),
    authors: regular ? item.getCreators().map((creator) => [creator.firstName, creator.lastName].filter(Boolean).join(" ")).join(", ") : "",
    year: regular ? String(item.getField("date")).match(/\b\d{4}\b/)?.[0] ?? "" : "",
    abstract: regular ? String(item.getField("abstractNote")).slice(0, 20000) : "",
  };
}

function canvasDir() {
  return PathUtils.join(Zotero.DataDirectory.dir, storageDir);
}

export function canvasFilePath(paper: Zotero.Item) {
  const library = Zotero.Libraries.get(paper.libraryID);
  const scope = library && library.libraryType === "group" ? `group-${library.libraryTypeID}` : "library";
  return PathUtils.join(canvasDir(), `${scope}-${paper.key}.json`);
}

function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const previous = fileLocks.get(file) ?? Promise.resolve();
  const current = previous.then(action, action);
  const settled = current.then(() => undefined, () => undefined);
  fileLocks.set(file, settled);
  void settled.then(() => {
    if (fileLocks.get(file) === settled) fileLocks.delete(file);
  });
  return current;
}

function legacyNotes(paper: Zotero.Item) {
  if (!paper.isRegularItem() || typeof paper.getNotes !== "function") return [];
  return Zotero.Items.get(paper.getNotes()).filter((note) => note.hasTag(storageTag) && !note.deleted);
}

function parseLegacyNote(content: string): CanvasDocument {
  const encoded = content.match(/ZCANVAS1:([A-Za-z0-9+/=]+)/)?.[1];
  if (!encoded) throw new Error("画布数据笔记格式无效。");
  try {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    return documentSchema.parse(JSON.parse(strFromU8(unzlibSync(bytes))));
  } catch {
    throw new Error("无法读取画布数据笔记，请检查它是否损坏。");
  }
}

async function removeLegacyNotes(paper: Zotero.Item, notes = legacyNotes(paper)) {
  if (!notes.length) return;
  const library = Zotero.Libraries.get(paper.libraryID);
  if (!library || !library.editable) return;
  for (const note of notes) {
    if (typeof note.eraseTx === "function") await note.eraseTx();
  }
}

async function writeCanvasFile(file: string, document: CanvasDocument) {
  if (!document.cards.length && !document.hiddenTurns?.length) {
    if (await IOUtils.exists(file)) await IOUtils.remove(file, { ignoreAbsent: true });
    return;
  }
  await IOUtils.makeDirectory(canvasDir(), { ignoreExisting: true });
  await IOUtils.writeUTF8(file, JSON.stringify(document), { tmpPath: `${file}.tmp` });
}

export function storage(paper: Zotero.Item) {
  const file = canvasFilePath(paper);
  return {
    load() {
      return withFileLock(file, async () => {
        if (await IOUtils.exists(file)) {
          let document: CanvasDocument;
          try {
            document = documentSchema.parse(JSON.parse(await IOUtils.readUTF8(file)));
          } catch {
            throw new Error("无法读取本地画布数据，请检查数据文件是否损坏。");
          }
          await removeLegacyNotes(paper).catch(() => undefined);
          return document;
        }
        const notes = [...legacyNotes(paper)].sort((a, b) =>
          String((b as { dateModified?: string }).dateModified ?? "")
            .localeCompare(String((a as { dateModified?: string }).dateModified ?? "")));
        if (!notes.length) return null;
        let document: CanvasDocument | undefined;
        let lastError: unknown;
        for (const note of notes) {
          try {
            document = parseLegacyNote(note.getNote());
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!document) throw lastError;
        try {
          await writeCanvasFile(file, document);
        } catch {
          throw new Error("Zotero 无法保存画布数据。");
        }
        await removeLegacyNotes(paper, notes).catch(() => undefined);
        return document;
      });
    },
    save(document: CanvasDocument) {
      return withFileLock(file, async () => {
        try {
          await writeCanvasFile(file, document);
        } catch {
          throw new Error("Zotero 无法保存画布数据。");
        }
        await removeLegacyNotes(paper).catch(() => undefined);
      });
    },
  };
}

export async function migrateLegacyNotes() {
  await (Zotero as typeof Zotero & { Schema?: { schemaUpdatePromise?: Promise<void> } }).Schema?.schemaUpdatePromise;
  const libraries = Zotero.Libraries.getAll?.() ?? [];
  for (const library of libraries) {
    const search = Object.assign(new Zotero.Search(), { libraryID: library.libraryID });
    search.addCondition("tag", "is", storageTag);
    const ids = await search.search();
    if (!ids.length) continue;
    const items = await Zotero.Items.getAsync(ids);
    const papers = new Map<number, Zotero.Item>();
    for (const item of items) {
      if (item.deleted) continue;
      const paper = parentPaper(item);
      if (paper && legacyNotes(paper).length) papers.set(paper.id, paper);
    }
    for (const paper of papers.values()) {
      await storage(paper).load().catch(() => undefined);
    }
  }
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
      if (!attachment || (attachment.id !== paper.id && attachment.parentID !== paper.id) || !attachment.isPDFAttachment()) return null;
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
      const library = Zotero.Libraries.get(paper.libraryID);
      if (!library || !library.editable) throw new Error("当前文库为只读。");
      const links = sources.map(({ label, uri }) => `<li><a href="${escape(uri)}">${escape(label)}</a></li>`).join("");
      const note = Object.assign(new Zotero.Item("note"), { libraryID: paper.libraryID });
      if (paper.isRegularItem()) {
        note.parentID = paper.id;
      } else {
        const collections = typeof paper.getCollections === "function" ? paper.getCollections() : [];
        if (collections.length && typeof note.setCollections === "function") note.setCollections(collections);
        if (typeof note.addRelatedItem === "function") note.addRelatedItem(paper);
      }
      note.setNote(`<h1>Canvas Chat · 阅读笔记</h1>${noteBody(text)}${links ? `<h2>来源</h2><ul>${links}</ul>` : ""}`);
      await note.saveTx();
      if (!paper.isRegularItem() && typeof paper.addRelatedItem === "function" && typeof paper.saveTx === "function") {
        paper.addRelatedItem(note);
        await paper.saveTx().catch(() => undefined);
      }
      return `zotero://select/${itemPath(note)}`;
    },
  };
}
