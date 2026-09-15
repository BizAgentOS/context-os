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
  const card = (title, subtitle) => {
    const e = el("section", "ep-card");
    e.append(el("h2", "", title));
    if (subtitle) e.append(el("p", "ep-caption", subtitle));
    return e;
  };
  const fill = (container, items, missing) => {
    if (items.length) items.forEach(r => container.append(fact(r)));
    else {
      container.append(el("p", "ep-empty", missing));
      if (!actions.readonly) container.append(ask(missing));
    }
  };
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
  if (!identity.length) metadata.append(el("span", "ep-meta", "主体、地区与行业信息待补充"));
  const edit = name ? btn(actions.readonly ? "查看企业信息" : "编辑企业信息", () => actions.edit(name), "quiet-button") : ask("请帮我补充企业名称、主营业务和所在地区。");
  header.append(mark, intro, metadata);
  if (name || !actions.readonly) header.append(edit);
  root.append(header);
  const nav = el("nav", "ep-tabs");
  nav.setAttribute("aria-label", "企业与数据分区");
  const panel = el("div", "ep-panel");
  panel.id = "enterprise-panel";
  const tabs = [["overview", "业务全景"], ["organization", "发展与组织"], ["sources", "资料与数据"]];
  for (const [id, text] of tabs) {
    const b = btn(text, () => actions.changeTab(id), id === actions.tab ? "ep-tab active" : "ep-tab");
    if (id === actions.tab) b.setAttribute("aria-current", "page");
    b.setAttribute("aria-controls", panel.id);
    nav.append(b);
  }
  if (!actions.readonly) nav.append(btn("查看基础本体 ↗", actions.ontology, "ep-link ep-ontology-link"));
  root.append(nav, panel);
  const sources = el("section", "setup-sources");
  sources.id = "setup-sources";
  sources.tabIndex = -1;
  sources.setAttribute("aria-label", "资料与数据");
  sources.hidden = actions.tab !== "sources";
  root.append(sources);
  if (actions.tab === "sources") return { root, sources };

  const grid = el("div", "ep-grid");
  panel.append(grid);
  if (actions.tab === "organization") {
    const history = card("发展沿革", "企业的重要阶段与变化，保留资料中的时间和依据。");
    fill(history, pick(/(history|milestone|founded|foundingDate|established|timeline)/i), "尚未补充发展沿革。");
    const organization = card("组织与职责", "部门、角色及协作边界。");
    fill(organization, pick(/(department|organization|role|process)/i), "尚未补充组织与职责。");
    grid.append(history, organization);
    // Preserve non-standard enterprise facts instead of silently dropping them.
    const other = rows.filter(r => !used.has(r) && !/^(company\.(business|customers?|scope|goal)|business|goals?)$/.test(r.key));
    if (other.length) {
      const extras = card("其他企业信息", "保留现有资料中的补充信息。");
      extras.classList.add("ep-wide");
      other.forEach(r => extras.append(fact(r)));
      grid.append(extras);
    }
  } else {
    const left = el("div", "ep-stack");
    const operations = card("业务构成", "公司提供什么产品与服务，如何开展业务。");
    const offerings = el("div", "ep-offerings");
    fill(offerings, pick(/^(company\.(business|products?|services?|process)|business|business_description|description|products?|services?)$/), "尚未补充产品、服务和业务流程。");
    operations.append(offerings);
    const relations = card("核心业务关系", "从基础定义查看业务对象之间的联系。");
    const foundation = state.foundation?.current;
    const body = foundation?.content;
    if (body?.relations?.length) {
      relations.append(el("p", "ep-meta", `${foundation.status === "adopted" ? "已采用" : "候选待核对"} · v${foundation.version}`));
      for (const relation of body.relations.slice(0, 4)) {
        const label = id => body.concepts.find(c => c.id === id)?.name || id;
        const row = el("div", "ep-relation");
        row.append(el("span", "ep-object", label(relation.from)), el("span", "ep-edge", `— ${relation.name} →`), el("span", "ep-object", label(relation.to)));
        relations.append(row);
      }
      if (body.relations.length > 4) relations.append(el("p", "ep-meta", `显示前 4 条，共 ${body.relations.length} 条关系定义`));
    } else {
      relations.append(el("p", "ep-empty", "尚未形成基础业务关系。可从企业介绍中整理核心概念，再逐步补充关系。"));
      if (!actions.readonly) relations.append(ask("请基于已有企业资料，协助整理核心业务概念和关系。"));
    }
    if (actions.foundation) {
      const full = el("details", "ep-foundation");
      full.append(el("summary", "", "查看基础定义与依据"), actions.foundation());
      relations.append(full);
    }
    left.append(operations, relations);
    const audience = card("服务对象与范围", "了解客户、服务区域与业务边界。");
    fill(audience, pick(/^(company\.(customers?|scope|boundary|scale)|customers?|scope|boundary)$/), "尚未补充服务对象与业务范围。");
    grid.append(left, audience);
    const footer = el("div", "ep-footer ep-wide");
    const goal = card("本次关注的问题");
    fill(goal, pick(/^(company\.goal|goals?)$/), "希望先打通哪些业务信息？");
    const data = card("资料与数据", "企业资料、业务记录与指标，共同支撑对企业的理解。");
    data.append(btn("查看与接入 →", () => actions.changeTab("sources")));
    footer.append(goal, data);
    grid.append(footer);
  }
  return { root, sources };
}
