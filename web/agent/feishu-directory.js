import { element as el, action } from "./connection-ui.js";

export function renderFeishuDirectory(listing, selected, results, actions) {
  const root = el("section", null, "feishu-directory");
  root.append(el("h3", `目录：${listing.directory.title}`), el("p", listing.coverage.complete
    ? `当前目录共 ${listing.items.length} 项 · 仅列出直接子文件`
    : `当前页 ${listing.items.length} 项${listing.coverage.hasMore ? " · 还有下一页" : " · 已到最后一页"} · 仅列出直接子文件`, "connection-note"));
  const commands = el("div", null, "connection-actions");
  commands.append(action("返回已读资料", actions.back));
  if (listing.directory.parentUrl) commands.append(action("上级目录", () => actions.browse(listing.directory.parentUrl)));
  root.append(commands);
  const read = action(`读取勾选文件（${selected.size}）`, actions.read, "primary-button");
  read.disabled = !selected.size;
  const files = el("div", null, "feishu-directory-list");
  for (const item of listing.items) {
    const row = el("div", null, "feishu-directory-row");
    const label = el("label"), check = el("input"); check.type = "checkbox";
    check.checked = selected.has(item.url); check.disabled = !item.readable;
    check.addEventListener("change", () => {
      if (check.checked) selected.add(item.url); else selected.delete(item.url);
      read.textContent = `读取勾选文件（${selected.size}）`; read.disabled = !selected.size;
    });
    const copy = el("span");
    const saved = item.saved, result = results.get(item.url);
    const status = result ? result.ok ? `已保存 · ${result.characters} 字符` : `读取失败：${result.error}`
      : saved ? `已保存 · ${saved.characters} 字符 · 快照 v${saved.sourceVersion}` : item.readable ? "尚未读取正文" : "此类型暂不支持读取正文";
    copy.append(el("strong", item.title), el("small", `${item.type === "file" ? "附件" : item.type === "docx" ? "在线文档" : item.type}${item.hasChildren ? " · 含子文件" : ""} · ${status}`));
    label.append(check, copy); row.append(label);
    if (saved || result?.ok) row.append(action("查看正文", () => actions.open(result?.sourceId || saved.sourceId)));
    if (item.hasChildren) row.append(action("展开子文件", () => actions.browse(item.url)));
    files.append(row);
  }
  if (!listing.items.length) files.append(el("p", "此页面没有子文件。如果你粘贴的是单个文件链接，请查看它的上级目录。", "connection-note"));
  root.append(files, read, el("p", "只读取本页勾选的文件；子目录需单独展开。文件中的链接会作为正文保存，不会自动跟随访问。", "connection-note"));
  if (listing.coverage.nextPageToken) root.append(action("下一页", () => actions.browse(listing.directory.url, false, listing.coverage.nextPageToken)));
  return root;
}
