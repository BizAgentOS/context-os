import { el, btn, modal, field } from "./relation-corrections.js";
import { inspectChange } from "./mapping-changes.js";
import { safeText, technicalDetails } from "./ui-display.js";
const stateText = status => ({ candidate: "候选", checked: "检查通过", adopted: "已采用", cancelled: "已取消", superseded: "已替代", active: "使用中", revoked: "已撤销", draft: "草稿", previewed: "预览", committed: "已提交" })[status] || "待处理";
const when = value => value ? new Date(value).toLocaleString("zh-CN") : "时间未记录";
const recordLabel = (record, index) => `${record.title} · ${stateText(record.status)} · ${record.createdAt ? when(record.createdAt) : `记录 ${index + 1}`}`;
function explanation(report, box) {
  box.append(
    el("p", "原数据对应：此接入方当前使用的规则"),
    el("p", report.targetRef ? "目标数据对应：本次修订后的规则" : "目标数据对应：尚未采用"),
    el(
      "p",
      report.affected
        ? "当前许可涉及修订规则或依赖，读取含义可能变化。"
        : "当前许可未发现直接规则影响；迁移仍会更新此接入方使用的规则。",
    ),
  );
  box.append(
    el(
      "p",
      "字段、关系和证据许可保持原样，不自动扩大。迁移保留密钥，客户端需刷新接入目录后继续使用。旧动态证据失效，源数据仍按需读取。",
      "source-meta",
    ),
  );
  for (const g of report.grants)
    box.append(
      el(
        "p",
        `${g.type}：${g.fields.join("、")}；关系 ${g.relations.join("、") || "无"}；属性依据 ${g.evidence?.fields.join("、") || "无"}；关系依据 ${g.evidence?.relations.join("、") || "无"}`,
      ),
    );
  if (report.removedContextEvidence.length)
    box.append(
      el(
        "p",
        "本次明确移除的旧背景依据：" +
          report.removedContextEvidence.map((e) => e.label).join("、"),
      ),
    );
  for (const reason of report.reasons)
    box.append(el("p", reason.replace(/v[23]视图/g, "消费视图"), "source-meta"));
  box.append(technicalDetails(report));
}
export function inspectMigration(record, api, onSaved) {
  const d = modal("消费视图迁移确认"),
    body = el("div");
  d.append(body);
  let current = record,
    last = null;
  const draw = () => {
    body.replaceChildren(
      el("h3", current.title),
      el(
        "p",
        `${stateText(current.status)} · ${when(current.createdAt)}`,
      ),
      technicalDetails(current),
    );
    explanation(current.content.report, body);
    if (current.status === "committed")
      body.append(
        el(
          "p",
          "此接入方已完成迁移。当前状态请重新读取视图；历史回执不代表仍获授权。",
        ),
      );
    const status = el("p");
    status.setAttribute("role", "status");
    body.append(status);
    if (current.status === "previewed" && current.content.report.compatible)
      body.append(
        btn("确认迁移此视图", async () => {
          const payload = { id: current.id, version: current.version };
          if (!last) last = { ...payload, operationId: crypto.randomUUID() };
          const buttons = [...body.querySelectorAll("button")];
          buttons.forEach((b) => (b.disabled = true));
          status.textContent = "正在重新校验并迁移…";
          try {
            const r = await api("/api/live/migrations/commit", last);
            onSaved?.(r);
            current = r.saved;
            if (d.isConnected) draw();
          } catch (e) {
            if (d.isConnected)
              status.textContent = safeText(`未确认迁移：${e.message}。可重试原请求或重新生成预览。`);
          } finally {
            buttons.forEach((b) => (b.disabled = false));
          }
        }),
      );
  };
  draw();
}
export function inspectConsumerImpact(change, api, onSaved) {
  const d = modal("变更对消费者的影响"),
    body = el("div");
  d.append(body);
  let generation = 0,
    offset = 0;
  const load = async () => {
    const request = ++generation;
    body.replaceChildren(el("p", "正在核对当前消费视图…"));
    try {
      const info = await api("/api/live/migrations/impact", {
        changeRef: { id: change.id, version: change.version },
        offset,
        limit: 20,
      });
      if (!d.isConnected || request !== generation) return;
      body.replaceChildren(
        el("h3", change.title),
        el("p", `${stateText(info.status)} · ${when(change.createdAt)}`),
        technicalDetails({ change, info }),
      );
      body.append(
        btn("查看规则差异与样本依据", () =>
          inspectChange(change, api, onSaved),
        ),
      );
      body.append(
        el(
          "p",
          `当前基线共有 ${info.coverage.total} 份消费视图；另有 ${info.legacy.count} 份历史视图保持原合同。本页每次最多20份，不执行批量自动迁移。`,
          "source-meta",
        ),
      );
      if (!info.items.length) body.append(el("p", "此基线当前没有消费视图。"));
      for (const [index, view] of info.items.entries()) {
        const card = el("article", "", "live-card");
        card.append(
          el("h3", view.title),
          el("p", `${stateText(view.status)} · ${view.createdAt ? when(view.createdAt) : `记录 ${offset + index + 1}`}`),
        );
        explanation(view, card);
        let drop;
        if (view.requiresDropContextEvidence) {
          const label = el("label", "", "view-permission");
          drop = el("input");
          drop.type = "checkbox";
          label.append(
            drop,
            document.createTextNode(
              "同意移除此视图绑定旧模型的全部文档/BI背景依据",
            ),
          );
          card.append(label);
        }
        if (view.status === "active" && info.status === "adopted") {
          const status = el("p");
          status.setAttribute("role", "status");
          let last = null;
          const button = btn("生成迁移预览", async () => {
            const payload = {
                viewRef: { id: view.id, version: view.version },
                changeRef: { id: change.id, version: change.version },
                dropContextEvidence: Boolean(drop?.checked),
              },
              signature = JSON.stringify(payload);
            if (last?.signature !== signature)
              last = { signature, operationId: crypto.randomUUID() };
            button.disabled = true;
            if (drop) drop.disabled = true;
            try {
              const r = await api("/api/live/migrations/preview", {
                ...payload,
                operationId: last.operationId,
              });
              onSaved?.(r);
              if (d.isConnected && request === generation)
                inspectMigration(r.saved, api, onSaved);
            } catch (e) {
              if (d.isConnected && request === generation)
                status.textContent = safeText(`无法确认预览：${e.message}。`);
            } finally {
              button.disabled = false;
              if (drop) drop.disabled = false;
            }
          });
          card.append(button, status);
        }
        body.append(card);
      }
      if (offset > 0)
        body.append(
          btn("上一页", () => {
            offset = Math.max(0, offset - 20);
            load();
          }),
        );
      if (offset + info.coverage.shown < info.coverage.total)
        body.append(
          btn("下一页", () => {
            offset += 20;
            load();
          }),
        );
      body.append(btn("刷新当前影响", load));
    } catch (e) {
      if (d.isConnected && request === generation)
        body.replaceChildren(el("p", `无法读取影响：${e.message}`));
    }
  };
  load();
}
export function renderConsumerMigrations({ api, onSaved }) {
  const section = el("section");
  section.append(
    el("h2", "变更影响与消费者迁移"),
    el(
      "p",
      "查看第二页的同一变更，核对每个调用方的范围，再确认迁移指定视图。",
      "source-meta",
    ),
  );
  section.append(
    btn("查看变更与迁移记录", async () => {
      const d = modal("选择变更或迁移记录"),
        body = el("div");
      d.append(body);
      let selectionGeneration = 0;
      const open = async (id, version) => {
        const selection = ++selectionGeneration;
        try {
          const c = await api("/api/live/changes/read", { id, version });
          if (d.isConnected && selection === selectionGeneration)
            inspectConsumerImpact(c, api, onSaved);
        } catch (e) {
          if (d.isConnected && selection === selectionGeneration)
            body.append(el("p", e.message));
        }
      };
      const form = el("form"),
        id = field(form, "变更ID", ""),
        version = field(form, "变更版本", "1");
      version.type = "number";
      version.min = "1";
      const submit = btn("按引用打开", () => {});
      submit.type = "submit";
      form.append(submit);
      form.onsubmit = (e) => {
        e.preventDefault();
        open(id.value, Number(version.value));
      };
      const referenceEntry = el("details", "", "technical-information");
      referenceEntry.append(el("summary", "按技术引用打开"), form);
      body.append(referenceEntry);
      try {
        const [changes, migrations] = await Promise.all([
          api("/api/live/changes/list", {}),
          api("/api/live/migrations/list", {}),
        ]);
        if (!d.isConnected) return;
        body.append(el("h3", "最近40条映射变更"));
        for (const [index, c] of changes.items.entries())
          body.append(
            btn(recordLabel(c, index), () =>
              open(c.id, c.version),
            ),
          );
        body.append(el("h3", "最近40条迁移记录"));
        for (const [index, m] of migrations.items.entries())
          body.append(
            btn(recordLabel(m, index), async () => {
              const selection = ++selectionGeneration;
              try {
                const r = await api("/api/live/migrations/read", {
                  id: m.id,
                  version: m.version,
                });
                if (d.isConnected && selection === selectionGeneration)
                  inspectMigration(r, api, onSaved);
              } catch (e) {
                if (d.isConnected && selection === selectionGeneration)
                  body.append(el("p", e.message));
              }
            }),
          );
        body.append(technicalDetails({ changes: changes.items, migrations: migrations.items }));
      } catch (e) {
        if (d.isConnected) body.append(el("p", `读取失败：${e.message}`));
      }
    }),
  );
  return section;
}
