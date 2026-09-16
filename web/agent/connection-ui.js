export function element(tag, text, className = "") {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

export function action(text, callback, className = "quiet-button") {
  const button = element("button", text, className);
  button.type = "button";
  button.addEventListener("click", callback);
  return button;
}

export function field(text, type = "text") {
  const label = element("label", text, "connection-field");
  const input = element("input");
  input.type = type;
  input.autocomplete = "off";
  label.append(input);
  return { label, input };
}

export function connectionDialog(title, description) {
  const dialog = element("dialog", null, "settings-dialog connection-dialog");
  dialog.setAttribute("aria-label", title);
  const head = element("header", null, "dialog-heading");
  const body = element("div", null, "connection-body");
  const footer = element("div", null, "connection-footer");
  const status = element("p", null, "settings-status");
  status.setAttribute("role", "status");
  status.hidden = true;
  let closing = false;
  const shell = {
    dialog, body, footer,
    beforeClose: null,
    onClose: null,
    message(text) { status.textContent = text; status.hidden = !text; },
    async close() {
      if (closing) return;
      closing = true;
      try {
        if (await shell.beforeClose?.() !== false) dialog.close();
      } catch (error) { shell.message(error.message); }
      finally { closing = false; }
    },
  };
  head.append(element("h2", title), action("关闭", () => void shell.close()));
  dialog.append(head, element("p", description, "connection-description"), status, body, footer);
  dialog.addEventListener("cancel", event => { event.preventDefault(); void shell.close(); });
  dialog.addEventListener("close", () => { shell.onClose?.(); dialog.remove(); }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
  return shell;
}
