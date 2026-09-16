// Presentation only: statements and foundation references remain owned by the host.
export function renderEnterpriseProfile(state, actions) {
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    e.className = cls || "";
    if (text) e.textContent = text;
    return e;
  };
  const btn = (text, fn, cls = "ep-link") => {
    const b = el("button", cls, text);
    b.type = "button";
    b.addEventListener("click", fn);
    return b;
  };
  const rows = state.profile?.content?.statements || [];
  const used = new Set();
  const pick = (pattern) => rows.filter(r => pattern.test(r.key));
  const fact = (row) => {
    used.add(row);
    const b = btn("", () => actions.edit(row), "ep-fact");
    b.append(el("span", "ep-meta", `${actions.label(row.key)}${row.origin === "suggestion" ? " · 待核实" : ""}`), el("span", "ep-value", row.text));
    return b;
  };
  const ask = (text) => btn("请助手补充 ↗", () => actions.ask(text));
  const root = el("section", "setup-canvas enterprise-profile");
  const header = el("section", "ep-header");
  header.id = "setup-company";
  header.tabIndex = -1;
  header.setAttribute("aria-label", "企业概览");
  const names = pick(/^(company\.name|company_name|companyName|name)$/);
  const name = names.find(r => r.origin !== "suggestion");
  if (name) used.add(name);
  const title = name?.text || state.foundation?.current?.content?.enterprise?.name || "从你的企业开始";
  const mark = el("div", "ep-monogram", [...title][0]);
  mark.setAttribute("aria-hidden", "true");
  const intro = el("div", "ep-intro");
  intro.append(el("h1", "", title));
  const business = pick(/^(company\.business|business|business_description|description)$/);
  if (business.length) business.forEach(r => intro.append(fact(r)));
  else intro.append(el("p", "ep-caption", "介绍企业的主要业务，或上传一份企业资料，从已有信息开始。"));
  const metadata = el("div", "ep-metadata");
  const identity = pick(/^(company\.(legalName|legal_name|location|industry|founded|foundingDate)|location|industry|foundingDate)$/);
  identity.forEach(r => metadata.append(fact(r)));

  const edit = name ? btn(actions.readonly ? "查看企业信息" : "编辑企业信息", () => actions.edit(name), "quiet-button") : ask("请帮我补充企业名称、主营业务和所在地区。");
  header.append(mark, intro, metadata);
  if (name || !actions.readonly) header.append(edit);
  root.append(header);
  const remaining = rows.filter(r => !used.has(r));
  if (remaining.length) {
    const details = el("details", "ep-company-details");
    details.append(el("summary", "", "查看企业信息"));
    remaining.forEach(r => details.append(fact(r)));
    root.append(details);
  }
  const sources = el("section", "setup-sources");
  sources.id = "setup-sources";
  sources.tabIndex = -1;
  sources.setAttribute("aria-label", "资料与数据");
  root.append(sources);
  return { root, sources };
}
