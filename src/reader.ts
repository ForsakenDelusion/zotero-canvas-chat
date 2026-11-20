import type { Excerpt } from "../shared/schema";
import { makeAnchor, parentPaper } from "./library";

export function readerHooks(pluginId: string, open: (paper: Zotero.Item, excerpt?: Excerpt) => void, available: () => boolean) {
  const selection: _ZoteroTypes.Reader.EventHandler<"renderTextSelectionPopup"> = ({ doc, params, reader, append }) => {
    if (!available()) return;
    const attachment = reader.itemID ? Zotero.Items.get(reader.itemID) : undefined;
    const paper = parentPaper(attachment);
    const annotation = params.annotation;
    const page = annotation?.position?.pageIndex;
    const quote = annotation?.text?.trim();
    if (!paper || !attachment || !attachment.isPDFAttachment() || !quote || !Number.isInteger(page) || page! < 0) return;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "toolbar-button";
    button.textContent = "画布分支";
    button.title = "把选中的文字发到阅读画布";
    button.addEventListener("click", () => open(paper, { quote, anchor: makeAnchor(attachment, page!) }));
    append(button);
  };

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
    if (!paper) return;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "toolbar-button";
    button.textContent = "画布";
    button.title = "在 LLM for Zotero 右栏打开画布";
    button.addEventListener("click", () => open(paper));
    append(button);
  };

  Zotero.Reader.registerEventListener("renderTextSelectionPopup", selection, pluginId);
  Zotero.Reader.registerEventListener("createAnnotationContextMenu", annotationMenu, pluginId);
  Zotero.Reader.registerEventListener("renderToolbar", toolbar, pluginId);
  return () => {
    Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", selection);
    Zotero.Reader.unregisterEventListener("createAnnotationContextMenu", annotationMenu);
    Zotero.Reader.unregisterEventListener("renderToolbar", toolbar);
  };
}
