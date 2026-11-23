import type { Excerpt } from "../shared/schema";
import { makeAnchor, parentPaper } from "./library";

const toolbarButtonAttr = "data-zcanvas-toolbar-button";
const toolbarSectionAttr = "data-zcanvas-toolbar-section";

export function readerHooks(pluginId: string, open: (paper: Zotero.Item, excerpt?: Excerpt) => void, available: () => boolean) {
  let disposed = false;
  const injected = new Set<HTMLElement>();
  const watchedReaders = new WeakSet<_ZoteroTypes.ReaderInstance>();

  function createToolbarButton(doc: Document, paper: Zotero.Item) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "toolbar-button";
    button.setAttribute(toolbarButtonAttr, "");
    button.textContent = "画布";
    button.title = "在 LLM for Zotero 右栏打开画布";
    button.addEventListener("click", () => open(paper));
    return button;
  }

  function ensureToolbar(reader: _ZoteroTypes.ReaderInstance) {
    if (disposed || !available()) return;
    const paper = parentPaper(reader.itemID ? Zotero.Items.get(reader.itemID) : undefined);
    const doc = reader._iframeWindow?.document;
    if (!paper || !doc || doc.querySelector(`[${toolbarButtonAttr}]`)) return;
    const container = doc.querySelector(".toolbar .end > .custom-sections")
      ?? doc.querySelector(".end > .custom-sections");
    if (!container) return;
    const section = doc.createElement("div");
    section.className = "section";
    section.setAttribute(toolbarSectionAttr, "");
    section.append(createToolbarButton(doc, paper));
    container.append(section);
    injected.add(section);
  }

  function syncExistingReaders() {
    if (disposed) return;
    for (const reader of Zotero.Reader._readers ?? []) {
      ensureToolbar(reader);
      if (reader._initPromise && !watchedReaders.has(reader)) {
        watchedReaders.add(reader);
        void Promise.resolve(reader._initPromise).then(() => ensureToolbar(reader), () => undefined);
      }
    }
  }

  const annotationMenu: _ZoteroTypes.Reader.EventHandler<"createAnnotationContextMenu"> = ({ reader, params, append }) => {
    if (!available()) return;
    const attachment = reader.itemID ? Zotero.Items.get(reader.itemID) : undefined;
    const paper = parentPaper(attachment);
    const key = params.ids?.length === 1 ? params.ids[0] : undefined;
    if (!paper || !attachment || !attachment.isPDFAttachment() || !key) return;
    const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
    if (!item || item.parentID !== attachment.id || !["image", "highlight", "underline"].includes(item.annotationType)) return;
    let pageIndex: number;
    try {
      pageIndex = JSON.parse(item.annotationPosition).pageIndex;
      if (!Number.isInteger(pageIndex) || pageIndex < 0) return;
    } catch { return; }
    append({
      label: "发送到阅读画布",
      onCommand() {
        open(paper, {
          quote: item.annotationType === "image" ? item.annotationComment : item.annotationText,
          anchor: makeAnchor(attachment, pageIndex, item.key, item.annotationType === "image"),
        });
      },
    });
  };

  const toolbar: _ZoteroTypes.Reader.EventHandler<"renderToolbar"> = ({ reader, doc, append }) => {
    if (!available()) return;
    const paper = parentPaper(reader.itemID ? Zotero.Items.get(reader.itemID) : undefined);
    if (!paper || doc.querySelector(`[${toolbarButtonAttr}]`)) return;
    append(createToolbarButton(doc, paper));
  };

  Zotero.Reader.registerEventListener("createAnnotationContextMenu", annotationMenu, pluginId);
  Zotero.Reader.registerEventListener("renderToolbar", toolbar, pluginId);
  syncExistingReaders();
  if (Zotero.uiReadyPromise) {
    void Promise.resolve(Zotero.uiReadyPromise).then(syncExistingReaders, () => undefined);
  }
  const fallbackTimer = setTimeout(syncExistingReaders, 1500);
  return () => {
    disposed = true;
    clearTimeout(fallbackTimer);
    Zotero.Reader.unregisterEventListener("createAnnotationContextMenu", annotationMenu);
    Zotero.Reader.unregisterEventListener("renderToolbar", toolbar);
    for (const section of injected) section.remove();
    injected.clear();
    for (const reader of Zotero.Reader._readers ?? []) {
      const doc = reader._iframeWindow?.document;
      if (!doc) continue;
      doc.querySelectorAll(`[${toolbarSectionAttr}]`).forEach((section) => section.remove());
      doc.querySelectorAll(`[${toolbarButtonAttr}]`).forEach((button) => {
        const parent = button.parentElement;
        if (parent?.classList.contains("section") && parent.childElementCount === 1) parent.remove();
        else button.remove();
      });
    }
  };
}
