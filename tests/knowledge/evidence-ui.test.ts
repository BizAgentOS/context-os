import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser JavaScript is syntax-checked separately.
import { createEvidenceViewer } from '../../web/knowledge/evidence.js';
class Element {
  tag: string; text: string; children: Element[] = []; scrolled = false;
  constructor(tag = '', text = '') { this.tag = tag; this.text = text; }
  append(...els: Element[]) { this.children.push(...els); }
  replaceChildren(...els: Element[]) { this.children = els; }
  setAttribute() {}
  scrollIntoView() { this.scrolled = true; }
}
const node = (tag: string, text = '') => new Element(tag, text);
const text = (el: Element): string => [el.text, ...el.children.map(text)].join('\n');
test('evidence appears alongside the selected declaration with source value and quote', async () => {
  const panel = node('div'); let path = '';
  const show = createEvidenceViewer({ node, sourceName: () => '合同资料', api: async (url: string) => {
    path = url;
    assert.ok(text(panel).includes('正在读取'));
    return [{ source_id: 'source', revision: 1, locator: { kind: 'field', recordKey: 'C001', field: 'amount', row: 2, value: '1000000.00' } }, { source_id: 'pdf', revision: 1, locator: { kind: 'quote', start: 44, quote: 'Contract C001 amount is 1200000.00.' } }];
  } });
  await show({ id: 'assertion', revision: 2 }, panel);
  assert.equal(path, '/api/evidence/assertion?revision=2');
  assert.ok(text(panel).includes('1000000.00'));
  assert.ok(text(panel).includes('Contract C001 amount is 1200000.00.'));
  assert.ok(text(panel).includes('合同资料')); assert.equal(panel.scrolled, true);
});
test('empty and failed evidence requests leave visible feedback next to the declaration', async () => {
  const panel = node('div');
  await createEvidenceViewer({ node, api: async () => [] })({ id: 'a', revision: 1 }, panel);
  assert.ok(text(panel).includes('没有关联来源证据'));
  await assert.rejects(createEvidenceViewer({ node, api: async () => { throw new Error('读取权限不足'); } })({ id: 'a', revision: 1 }, panel), /读取权限不足/);
  assert.ok(text(panel).includes('读取证据失败：读取权限不足'));
});
