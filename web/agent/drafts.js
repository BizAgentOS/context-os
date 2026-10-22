// Drafts are browser-local and scoped by a stable, non-secret workspace ID.
// Never persist credentials or the rest of the application snapshot here.
import { readBrowserValue } from "./browser-storage.js";

export function createDraftStore(storage, workspaceId, onError) {
  const prefix = `context-os:drafts:v2:${workspaceId}:`;
  const legacyPrefix = `dataengine:drafts:v2:${workspaceId}:`;
  return {
    read(page) {
      try {
        return JSON.parse(readBrowserValue(storage, prefix + page, [legacyPrefix + page]) || "null");
      } catch {
        onError();
        return null;
      }
    },
    save(page, draft) {
      try {
        storage.setItem(prefix + page, JSON.stringify(draft));
      } catch {
        onError();
      }
    },
  };
}

export function parseLegacyDrafts(text) {
  const data = JSON.parse(text);
  if (
    !["context-os-legacy-drafts-v1", "dataengine-legacy-drafts-v1"].includes(data.format) ||
    !Array.isArray(data.drafts)
  )
    throw new Error("请选择旧版页面导出的草稿文件。");
  if (data.drafts.length > 4) throw new Error("草稿文件内容过多。");
  const pages = new Set();
  return data.drafts.map((draft) => {
    if (
      !["company", "sources", "ontology", "consumption"].includes(draft.page) ||
      pages.has(draft.page) ||
      typeof draft.text !== "string" ||
      draft.text.length > 6000
    )
      throw new Error("草稿页面或内容格式无效。");
    pages.add(draft.page);
    return { page: draft.page, text: draft.text };
  });
}
