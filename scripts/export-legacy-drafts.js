// Paste this entire script into the OLD, still-open four-page tab's console
// BEFORE reloading or restarting the service. It reads only visible composer
// text by visiting the old pages. It neither submits drafts nor reads secrets.
// Finish/stop any current run first. Previously unloaded memory is unavailable.
(async () => {
  const input = document.querySelector("#message-input");
  const controls = [...document.querySelectorAll("[data-page]")];
  if (!input || !controls.some((item) => item.dataset.page === "company"))
    throw new Error("请在仍打开的旧版四页界面运行。");
  if (!document.querySelector("#stop-button")?.hidden)
    throw new Error("请先完成或停止当前处理，再导出草稿。");
  const original = controls.find(
    (item) => item.getAttribute("aria-current") === "page",
  )?.dataset.page;
  const drafts = [];
  async function visit(control) {
    if (control.getAttribute("aria-current") === "page") return;
    if (control.disabled)
      throw new Error(
        `页面 ${control.dataset.page} 不可访问；未导出，请保留原标签页。`,
      );
    control.click();
    const deadline = Date.now() + 15000;
    while (control.getAttribute("aria-current") !== "page") {
      if (Date.now() > deadline)
        throw new Error("切换超时；未完成导出，请保留原标签页。");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    for (const control of controls) {
      await visit(control);
      drafts.push({ page: control.dataset.page, text: input.value });
    }
    const blob = new Blob(
      [
        JSON.stringify(
          { format: "context-os-legacy-drafts-v1", drafts },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "context-os-drafts.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally {
    const control = controls.find((item) => item.dataset.page === original);
    if (control) await visit(control);
  }
})();
