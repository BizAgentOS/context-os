import { renderEnterpriseProfile } from "./enterprise-profile.js";
import { renderLiveWorkspace } from "./live-workspace.js";
import { renderEvidenceWorkspace } from "./evidence.js";
import { parseLegacyDrafts } from "./drafts.js";

export function createDataProfile({ state, ui, $, pageLabels, node, button, api, mutate, navigate, draftKey, applySnapshot, label, openStatement, resizeInput, rememberDraft, openComposer, foundationPanel, shareMode, showCredential, renderSources, renderCanvas, startOnboarding, setFocus, errorMessage, updateComposer }) {
function renderDataProfile() {
  const changeTab = async (tab) => {
    ui.enterpriseTab = tab;
    renderCanvas(true);
    document.querySelector(".ep-tab.active")?.focus({ preventScroll: true });
    state.setupSection = tab === "sources" ? "sources" : "company";
    if (ui.page === "setup" && ui.enterpriseTab === tab && !ui.detail)
      document.querySelector(".ep-tab.active")?.focus({ preventScroll: true });
  };
  const { root: section, sources } = renderEnterpriseProfile(state, {
    tab: ui.enterpriseTab, readonly: shareMode, label, edit: openStatement,
    api: !shareMode && !state.demo ? api : null,
    onImportSaved: applySnapshot,
    upload: () => $("#file-input").click(),
    changeTab,
    ask: (text) => {
      const input = $("#message-input");
      input.value = input.value.trim() ? `${input.value}\n${text}` : text;
      rememberDraft();
      resizeInput();
      openComposer();
    },
    ontology: () => { section.closest("dialog")?.close(); return navigate("ontology"); },
    foundation: !shareMode && !state.demo ? foundationPanel : null,
  });
  if (!shareMode && !state.demo) {
    const initialize = button("完善初始化 →", "ob-reopen", () => startOnboarding(initialize));
    section.prepend(initialize);
    sources.append(
      renderLiveWorkspace("sources", state.live, {
        api,
        onImportSaved: applySnapshot,
        onConnectionsChanged: () => renderCanvas(true),
        mutate,
        showCredential,
      }),
    );
    const files = node("section", "data-files");
    files.append(
      node(
        "h2",
        "",
        `文件资料${state.sources.length ? ` · ${state.sources.length} 份` : ""}`,
      ),
    );
    files.append(button("上传资料", "quiet-button", () => $("#file-input").click()));
    files.append(
      state.sources.length
        ? renderSources()
        : node("p", "muted", "可通过底部附件接入 CSV、Markdown 或 TXT。"),
    );
    sources.append(files);
  } else sources.append(renderSources());
  if (!shareMode && !state.demo) {
    const evidence = node("details", "data-evidence");
    evidence.append(node("summary", "", "跨来源共同取证"), renderEvidenceWorkspace(state, { api, mutate }));
    sources.append(evidence);
  }
  if (!shareMode && (state.legacyHistory.length || ui.importedDrafts.length)) {
    const history = node("details", "setup-history");
    history.append(node("summary", "", "升级前保留的内容"));
    for (const entry of state.legacyHistory) {
      const title = entry.section === "company" ? "企业信息" : "数据接入";
      const content = node("div", "legacy-history-content");
      const open = button(`查看${title}旧记录`, "quiet-button", async () => {
        try {
          const result = await api(
            `/api/canvas/history?section=${entry.section}`,
          );
          content.replaceChildren();
          if (result.task.pending)
            content.append(
              node("p", "", `待确认：${result.task.pending.question}`),
            );
          for (const message of result.messages)
            content.append(
              node(
                "p",
                "",
                `${message.role === "user" ? "你" : "助手"}：${message.content}`,
              ),
            );
          if (!result.messages.length)
            content.append(
              node("p", "", "没有保留的聊天消息；已保存内容继续可用。"),
            );
        } catch (error) {
          errorMessage(error.message);
        }
      });
      history.append(
        open,
        node("p", "muted", entry.pending?.question || entry.nextStep),
        content,
      );
    }
    for (const draft of ui.importedDrafts.filter((item) => item.text)) {
      const title = { company: "企业信息", sources: "数据接入", ...pageLabels }[
        draft.page
      ];
      const item = node("details", "legacy-draft");
      item.append(
        node("summary", "", `${title}旧草稿`),
        node("p", "", draft.text),
        button("放入输入框", "quiet-button", async () => {
          const target = ["company", "sources"].includes(draft.page)
            ? "setup"
            : draft.page;
          const existing =
            target === ui.page
              ? { text: $("#message-input").value }
              : (ui.drafts.get(draftKey(target)) ?? ui.draftStore?.read(draftKey(target)));
          if (existing?.text?.trim())
            return errorMessage(
              `${pageLabels[target]}已有草稿，请先保存或清空，再恢复旧草稿。`,
            );
          if (target !== ui.page) await navigate(target);
          $("#message-input").value = draft.text;
          ui.focus = null;
          ui.pendingMessage = null;
          rememberDraft();
          resizeInput();
          updateComposer();
          openComposer();
        }),
      );
      history.append(item);
    }
    sources.append(history);
  }
  if (!shareMode) {
    const file = node("input");
    file.type = "file";
    file.accept = "application/json,.json";
    file.hidden = true;
    file.addEventListener("change", async () => {
      try {
        const selected = file.files[0];
        if (!selected) return;
        if (selected.size > 100000) throw new Error("草稿文件过大。");
        const drafts = parseLegacyDrafts(await selected.text());
        // Retain previously imported text; importing again never replaces it.
        for (const draft of drafts)
          if (
            !ui.importedDrafts.some(
              (item) => item.page === draft.page && item.text === draft.text,
            )
          )
            ui.importedDrafts.push(draft);
        ui.draftStore?.save("legacy", ui.importedDrafts);
        renderCanvas(true);
      } catch (error) {
        errorMessage(error.message);
      }
    });
    sources.append(
      button("导入旧版草稿", "quiet-button import-drafts", () => file.click()),
      file,
    );
  }
  for (const heading of sources.querySelectorAll("h1")) {
    const replacement = node("h2", heading.className, heading.textContent);
    heading.replaceWith(replacement);
  }
  return section;
}
return { renderDataProfile };
}
