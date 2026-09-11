const el = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
};

export function renderFoundation(
  value,
  { page, busy, adopt, discuss, locate },
) {
  const section = el("section", "foundation-panel");
  section.setAttribute("aria-label", "企业基础本体");
  section.append(el("h2", "", "企业基础本体"));
  const current = value?.current;
  if (!current) {
    section.append(
      el(
        "p",
        "muted",
        "向助手介绍企业，或上传 Markdown/TXT 企业资料，即可整理基础概念和关系。也可以先接入数据。",
      ),
    );
    return section;
  }
  const render = (artifact, historical = false) => {
    const body = artifact.content;
    const card = el("article", "foundation-version");
    card.dataset.foundationId = artifact.id;
    card.dataset.foundationVersion = String(artifact.version);
    card.append(
      el(
        "h3",
        "",
        `${body.enterprise.name} · ${artifact.status === "adopted" ? "已采用" : "候选待核对"} · v${artifact.version}`,
      ),
    );
    card.append(el("p", "muted", "未绑定来源 · 暂无可查询的业务对象"));
    const evidenceFor = (item) => {
      const details = el("details", "foundation-evidence");
      details.append(el("summary", "", "查看依据"));
      for (const ref of new Set([
        ...(item.evidenceRefs || []),
        ...(item.resolvedBy || []),
      ])) {
        const evidence = body.evidence.find((entry) => entry.id === ref);
        if (!evidence) continue;
        details.append(el("blockquote", "", evidence.quote));
        details.append(
          el(
            "small",
            "muted",
            evidence.kind === "document"
              ? `${evidence.title} · v${evidence.sourceVersion} · 已读取 ${new Date(evidence.readAt).toLocaleString("zh-CN")} · 适用时间未说明`
              : `用户陈述 · ${new Date(evidence.capturedAt).toLocaleString("zh-CN")} · 适用时间未说明`,
          ),
        );
        if (evidence.kind === "document" && locate) {
          const open = el("button", "quiet-button", "定位资料片段");
          open.type = "button";
          const result = el("div", "foundation-excerpt");
          open.onclick = async () => {
            open.disabled = true;
            try {
              const found = await locate({
                foundationId: artifact.id,
                version: String(artifact.version),
                evidenceId: evidence.id,
              });
              const paragraph = el("pre", "");
              paragraph.append(
                document.createTextNode(
                  found.text.slice(0, found.start - found.excerptStart),
                ),
                el("mark", "", found.quote),
                document.createTextNode(
                  found.text.slice(found.end - found.excerptStart),
                ),
              );
              result.replaceChildren(
                el(
                  "p",
                  "muted",
                  `${found.title} · 依据版本 v${found.sourceVersion} · 当前资料 v${found.currentSourceVersion}`,
                ),
                paragraph,
              );
            } catch (error) {
              const alert = el("p", "", error.message);
              alert.setAttribute("role", "alert");
              result.replaceChildren(alert);
            } finally {
              open.disabled = false;
            }
          };
          details.append(open, result);
        }
      }
      return details;
    };
    card.append(evidenceFor(body.enterprise));
    if (body.enterpriseChange && artifact.status === "candidate") {
      card.append(
        el(
          "p",
          "foundation-name-change",
          `同一企业名称纠正：${body.enterpriseChange.before} → ${body.enterpriseChange.after}。采用后保留原有概念身份。`,
        ),
      );
    }
    const concepts = el("ul", "foundation-concepts");
    for (const item of body.concepts) {
      const entry = el("li", "foundation-concept");
      entry.dataset.conceptId = item.id;
      entry.append(
        el("h4", "", item.name),
        el("p", "", item.description),
        evidenceFor(item),
      );
      concepts.append(entry);
    }
    card.append(concepts);
    if (body.relations.length) {
      const relations = el("ul", "foundation-relations");
      for (const item of body.relations) {
        const name = (id) => body.concepts.find((c) => c.id === id)?.name || id;
        const entry = el("li", "");
        entry.dataset.relationId = item.id;
        entry.append(
          el(
            "strong",
            "",
            `${name(item.from)} → ${item.name} → ${name(item.to)}`,
          ),
          el("p", "", item.description),
          evidenceFor(item),
        );
        relations.append(entry);
      }
      card.append(relations);
    }
    for (const [key, title] of [
      ["unknowns", "待补充"],
      ["conflicts", "待解决冲突"],
    ]) {
      if (!body[key].length) continue;
      const issues = el("details", "foundation-issues");
      issues.open = body[key].some((item) => !item.resolvedBy);
      issues.append(el("summary", "", title));
      const list = el("ul", "");
      for (const item of body[key]) {
        const entry = el(
          "li",
          "",
          `${item.resolvedBy ? "已补充 · " : ""}${item.description}`,
        );
        if (item.retained && item.proposed)
          entry.append(
            el("p", "", `原含义：${item.retained.description}`),
            el("p", "", `资料建议：${item.proposed.description}`),
          );
        if (item.resolvedBy || item.evidenceRefs)
          entry.append(evidenceFor(item));
        list.append(entry);
      }
      issues.append(list);
      card.append(issues);
    }
    if (body.changes?.length && artifact.status === "candidate") {
      const changes = el("details", "foundation-issues");
      changes.open = true;
      changes.append(el("summary", "", "相对已采用定义的变化"));
      const describe = (item, source) => {
        const name = (id) =>
          source.content.concepts.find((entry) => entry.id === id)?.name || id;
        return `${item.name}${item.from ? `（${name(item.from)} → ${name(item.to)}）` : ""}：${item.description}`;
      };
      for (const change of body.changes) {
        changes.append(
          el(
            "p",
            "",
            change.before
              ? `${describe(change.before, value.adopted || artifact)} → ${describe(change.after, artifact)}`
              : `新增 ${describe(change.after, artifact)}`,
          ),
        );
      }
      card.append(changes);
    }
    card.append(el("p", "muted", body.checks.description));
    if (!historical) {
      const actions = el("div", "foundation-actions");
      const edit = el("button", "quiet-button", "让助手补充或修正");
      edit.type = "button";
      edit.disabled = busy;
      edit.onclick = () => discuss(artifact);
      actions.append(edit);
      if (artifact.status === "candidate") {
        const button = el(
          "button",
          "quiet-button",
          body.enterpriseChange ? "确认名称纠正并采用" : "采用这版基础定义",
        );
        button.type = "button";
        const conflict = body.conflicts.some((item) => !item.resolvedBy);
        button.disabled = busy || conflict;
        button.onclick = () =>
          adopt({ page, id: artifact.id, version: artifact.version });
        actions.append(button);
        if (conflict)
          actions.append(el("span", "muted", "先补充冲突依据，再采用"));
      }
      card.append(actions);
    }
    return card;
  };
  section.append(render(current));
  if (value.adopted && current.version !== value.adopted.version) {
    const adopted = el("details", "foundation-previous");
    adopted.append(
      el("summary", "", `查看仍有效的已采用定义 · v${value.adopted.version}`),
      render(value.adopted, true),
    );
    section.append(adopted);
  }
  return section;
}
