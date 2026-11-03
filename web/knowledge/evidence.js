export function createEvidenceViewer({ api, node, sourceName = id => id }) {
  return async function showEvidence(candidate, panel) {
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', '当前声明的来源证据');
    panel.setAttribute('aria-live', 'polite');
    panel.replaceChildren(node('p', '正在读取这条声明的证据…'));
    try {
      const evidence = await api(`/api/evidence/${candidate.id}?revision=${candidate.revision}`);
      panel.replaceChildren(node('h4', `来源证据 · 声明修订 ${candidate.revision}`));
      if (!evidence.length) panel.append(node('p', '此修订没有关联来源证据，请查看人工判断及操作理由。'));
      for (const entry of evidence) {
        const card = node('article');
        card.append(node('p', `来源：${sourceName(entry.source_id)} · 版本 ${entry.revision}`));
        const locator = entry.locator;
        if (locator.kind === 'field') {
          card.append(node('p', `CSV 记录：${locator.recordKey} · 字段：${locator.field}${locator.row ? ` · 第 ${locator.row} 行` : ''}`), node('pre', typeof locator.value === 'string' ? locator.value : JSON.stringify(locator.value ?? null)));
        } else {
          card.append(node('p', `文档原文 · 字符起点 ${locator.start}`), node('blockquote', locator.quote));
        }
        const details = node('details');
        details.append(node('summary', '查看版本、定位与证据详情'), node('pre', JSON.stringify(entry, null, 2)));
        card.append(details); panel.append(card);
      }
      if (panel.isConnected !== false) panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (error) {
      panel.replaceChildren(node('p', `读取证据失败：${error.message}`));
      if (panel.isConnected !== false) panel.scrollIntoView({ block: 'nearest' });
      throw error;
    }
  };
}
