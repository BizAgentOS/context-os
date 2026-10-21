import { safeText, displayValue, fieldLabel } from "./ui-display.js";

const element = (tag, text) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = safeText(text); return node; };
function inline(parent, value) {
  const text = String(value ?? ""), pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(safeText(text.slice(position, match.index))));
    const token = match[0];
    if (token.startsWith("`")) parent.append(element("code", token.slice(1, -1)));
    else if (token.startsWith("**")) parent.append(element("strong", token.slice(2, -2)));
    else if (token.startsWith("*")) parent.append(element("em", token.slice(1, -1)));
    else {
      const [, label, href] = /^\[([^\]]+)\]\((.+)\)$/.exec(token);
      const link = element("a", label);
      try {
        const url = new URL(href, location.href);
        if (["https:", "http:", "mailto:"].includes(url.protocol)) { link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer"; }
      } catch { /* Invalid links remain ordinary visible text. */ }
      parent.append(link);
    }
    position = match.index + token.length;
  }
  parent.append(document.createTextNode(safeText(text.slice(position))));
}

/** Markdown is constructed as DOM nodes. Model/source HTML is always inert text. */
export function renderMarkdown(value) {
  const root = element("div"); root.className = "message-markdown";
  const text = String(value ?? "");
  if (/^[\[{]/.test(text.trim())) {
    try { root.append(element("p", displayValue(JSON.parse(text)))); return root; } catch { /* Ordinary prose may begin with a bracket. */ }
  }
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^\s*```/.test(line)) {
      const code = [], language = line.trim().slice(3).trim().toLowerCase();
      for (index++; index < lines.length && !/^\s*```/.test(lines[index]); index++) code.push(lines[index]);
      index++;
      if (language === "json") { try { root.append(element("p", displayValue(JSON.parse(code.join("\n"))))); } catch { root.append(element("p", "结果较长，请打开对应记录查看完整内容。")); } continue; }
      const pre = element("pre"); pre.append(element("code", code.join("\n"))); root.append(pre); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const node = element(`h${Math.min(heading[1].length + 2, 6)}`); inline(node, heading[2]); root.append(node); index++; continue; }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || "")) {
      const cells = value => value.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
      const table = element("table"), head = element("thead"), header = element("tr");
      for (const title of cells(line)) { const cell = element("th"); inline(cell, title); header.append(cell); }
      head.append(header); table.append(head); index += 2;
      const body = element("tbody");
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        const row = element("tr"); for (const text of cells(lines[index++])) { const cell = element("td"); inline(cell, text); row.append(cell); } body.append(row);
      }
      table.append(body); const wrap = element("div"); wrap.className = "message-table"; wrap.append(table); root.append(wrap); continue;
    }
    const item = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      const list = element(item[1] ? "ul" : "ol");
      while (index < lines.length) {
        const next = /^\s*(?:([-*+])|\d+[.)])\s+(.+)$/.exec(lines[index]);
        if (!next || Boolean(next[1]) !== Boolean(item[1])) break;
        const entry = element("li"); inline(entry, next[2]); list.append(entry); index++;
      }
      root.append(list); continue;
    }
    if (/^>\s?/.test(line)) { const quote = element("blockquote"); inline(quote, line.replace(/^>\s?/, "")); root.append(quote); index++; continue; }
    const paragraph = element("p"); inline(paragraph, line); root.append(paragraph); index++;
  }
  return root;
}

export function renderResultTable(result) {
  const wrap = element("section"); wrap.className = "run-query-result";
  wrap.append(element("h5", result.title || "查询结果"));
  const hidden = new Set(["sourceId", "modelId", "modelVersion", "snapshotId", "bindingId", "conceptId", "evidenceRefs", "sourceVersions", "connections"]);
  const columns = [...new Set(result.rows.flatMap(row => Object.keys(row)))].filter(key => !hidden.has(key)).slice(0, 20);
  const table = element("table"), head = element("thead"), header = element("tr");
  for (const column of columns) header.append(element("th", column === "$id" ? "记录" : fieldLabel(column)));
  head.append(header); table.append(head);
  const body = element("tbody");
  for (const record of result.rows) { const row = element("tr"); for (const column of columns) row.append(element("td", displayValue(record[column]))); body.append(row); }
  table.append(body); const scroll = element("div"); scroll.className = "message-table"; scroll.append(table); wrap.append(scroll);
  if (!result.rows.length) wrap.append(element("p", "本次查询没有返回记录。"));
  const coverage = result.coverage;
  wrap.append(element("p", result.truncated || coverage?.complete === false ? "部分结果；不能代表完整数据范围。" : coverage?.complete === true ? "本次读取范围覆盖完整。" : "读取覆盖范围未知。"));
  return wrap;
}
