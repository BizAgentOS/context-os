// Drafts are browser-local and scoped by a stable, non-secret workspace ID.
// Never persist credentials or the rest of the application snapshot here.
export function createDraftStore(storage, workspaceId, onError) {
  const prefix = `dataengine:drafts:v2:${workspaceId}:`;
  return {
    read(page) {
      try {
        return JSON.parse(storage.getItem(prefix + page) || "null");
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
    data.format !== "dataengine-legacy-drafts-v1" ||
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
