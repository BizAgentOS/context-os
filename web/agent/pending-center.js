/** Current attention projection; FEATURE_044 replaces its data with the unified pending API. */
export function renderPendingCenter(state, { page, node, button, open }) {
  const entries = (state.attention || []).filter(entry => entry.page === page);
  if (!entries.length) return null;
  const section = node("aside", "attention-list"); section.setAttribute("aria-label", "待处理的企业记忆");
  section.append(node("h2", "subsection-title", "待处理"));
  for (const entry of entries) {
    const row = button("", "attention-item", () => open(entry));
    row.append(node("strong", "", entry.title));
    if (entry.detail && entry.detail !== entry.title) row.append(node("span", "", entry.detail));
    section.append(row);
  }
  return section;
}
