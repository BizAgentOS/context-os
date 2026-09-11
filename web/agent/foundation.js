import { bindConcept, previewBinding } from "./foundation-bindings.js";
const el = (tag, className, text) => {
  const element = document.createElement(tag);
  element.className = className;
  if (text) element.textContent = text;
  return element;
};

export function renderFoundation(
  value,
  { page, busy, adopt, discuss, locate, live, api, mutate },
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
    card.append(
      el(
        "p",
        "muted",
        body.consumerReadiness?.objectsQueryable
          ? "部分概念已绑定业务来源 · 按需查询实例"
          : "尚无已采用且有效的执行映射 · 基础概念继续保留",
      ),
    );
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
            evidence.kind === "knowledge"
              ? `${evidence.title} · 知识文档 ${evidence.documentId} / ${evidence.segmentId} · 版本 ${evidence.revision} · 读取 ${new Date(evidence.readAt).toLocaleString("zh-CN")} · ${evidence.coverage?.complete ? "当前片段完整" : "部分片段"} · 适用时间未说明`
              : evidence.kind === "web"
                ? `${evidence.title} · 公开网页 · 已读取 ${new Date(evidence.readAt).toLocaleString("zh-CN")} · ${evidence.coverage?.complete ? "该次已读完整正文" : "部分正文，覆盖不完整"} · 适用时间未说明`
                : evidence.kind === "document"
                  ? `${evidence.title} · v${evidence.sourceVersion} · 已读取 ${new Date(evidence.readAt).toLocaleString("zh-CN")} · 适用时间未说明`
                  : `用户陈述 · ${new Date(evidence.capturedAt).toLocaleString("zh-CN")} · 适用时间未说明`,
          ),
        );
        if (
          ["document", "web", "knowledge"].includes(evidence.kind) &&
          locate
        ) {
          if (evidence.kind === "web") {
            const link = el("a", "", "打开原网页");
            link.href = evidence.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            details.append(document.createTextNode(" "), link);
          }
          const open = el(
            "button",
            "quiet-button",
            evidence.kind === "web" ? "查看当时网页片段" : "定位资料片段",
          );
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
                  found.kind === "knowledge"
                    ? `${found.title} · 读取时版本 ${found.revision} · 连接${found.connectionStatus === "ready" ? "可用" : "已停用"} · 保存的片段不代表当前源内容`
                    : found.kind === "web"
                      ? `${found.url} · 读取时快照，不代表网页当前内容`
                      : `${found.title} · 依据版本 v${found.sourceVersion} · 当前资料 v${found.currentSourceVersion}`,
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
      const bindings = item.bindings || [];
      entry.append(
        el(
          "p",
          "source-meta",
          item.mappingStatus === "bound"
            ? "已绑定业务来源"
            : "尚无已采用且有效的绑定",
        ),
      );
      for (const binding of bindings) {
        const row = el("div", "foundation-actions");
        row.append(
          el(
            "p",
            "source-meta",
            `${binding.status === "adopted" ? "已采用" : binding.status === "candidate" ? "候选" : "不可用"} · ${binding.capability} · 映射 v${binding.modelVersion} · 身份 ${binding.identity || "未提供"}${binding.reason ? " · " + binding.reason : ""}`,
          ),
        );
        const details = el("details", "");
        details.append(el("summary", "", "查看字段映射"));
        for (const [property, field] of Object.entries(binding.fields))
          details.append(el("p", "source-meta", `${property} ← ${field}`));
        row.append(details);
        if (binding.status !== "unavailable" && api) {
          const preview = el(
            "button",
            "quiet-button",
            binding.status === "adopted" ? "查看业务实例" : "预览候选实例",
          );
          preview.type = "button";
          preview.onclick = () => previewBinding(item, binding, api);
          row.append(preview);
          if (binding.status === "candidate" && mutate) {
            const accept = el("button", "quiet-button", "采用此执行子集");
            accept.type = "button";
            accept.disabled = busy;
            accept.onclick = () =>
              mutate("/api/live/adopt", {
                id: binding.modelId,
                version: binding.modelVersion,
              });
            row.append(accept);
          }
        }
        entry.append(row);
      }
      if (artifact.status === "adopted" && live && mutate) {
        const bind = el("button", "quiet-button", "绑定业务来源");
        bind.type = "button";
        bind.disabled = busy;
        bind.onclick = () => bindConcept(artifact, item, live, api, mutate);
        entry.append(bind);
      }
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
          el(
            "p",
            "source-meta",
            item.mappingStatus === "bound"
              ? "关系已绑定执行映射"
              : "关系尚未绑定有效执行映射",
          ),
          evidenceFor(item),
        );
        relations.append(entry);
      }
      card.append(relations);
    }
    for (const [key, title] of [
      ["unknowns", "待补充"],
      [
        "conflicts",
        body.conflicts.some((item) => !item.resolvedBy)
          ? "待解决冲突"
          : "已核对冲突",
      ],
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
          `${item.resolvedBy ? (key === "conflicts" ? "已解决 · " : "已补充 · ") : ""}${item.description}`,
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
