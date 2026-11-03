import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser JavaScript is verified separately with node --check.
import { createPlanWorkspace, discoveryDecisionState } from '../../web/knowledge/plans.js';

function draft() {
  return { id: 'draft', revision: 3, status: 'draft', definition: { name: '合同管理', types: [{ id: 'Contract', name: '合同', description: '一般业务合同', identityNamespaces: [], properties: [{ id: 'amount', name: '金额', valueType: 'decimal', required: false, multiple: false }] }], links: [], discoveryEvidence: [] }, discovery: { validation: { definitionHash: 'current', issues: [{ id: 'first', kind: 'first_release', memberId: 'ontology', question: '首次启用' }] }, review: null as any } };
}
test('publication decision state requires current definition and event acknowledgement', () => {
  const current = draft();
  assert.equal(discoveryDecisionState(current).pending, true);
  current.discovery.review = { definitionHash: 'current', issueIds: ['first'] };
  assert.equal(discoveryDecisionState(current).pending, false);
  current.discovery.review.definitionHash = 'old';
  assert.equal(discoveryDecisionState(current).pending, true);
  current.discovery.validation.issues = [];
  assert.equal(discoveryDecisionState(current).pending, false);
});

test('first-release panel explains scope, requires reason, and saves current event before publishing', async () => {
  class Element {
    children: Element[] = []; value = ''; disabled = false; className = ''; placeholder = ''; rows = 0;
    tag: string; text: string;
    constructor(tag = '', text = '') { this.tag = tag; this.text = text; }
    append(...elements: Element[]) { this.children.push(...elements); }
    replaceChildren(...elements: Element[]) { this.children = elements; }
    addEventListener() {}
  }
  const elements = new Map<string, Element>();
  const querySelector = (s: string) => { if (!elements.has(s)) elements.set(s, new Element()); return elements.get(s)!; };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector } });
  const buttons = new Map<string, () => Promise<void>>(), calls: any[] = [];
  const node = (tag: string, text = '') => new Element(tag, text);
  const current = draft(); querySelector('#definition').value = JSON.stringify(current.definition);
  let opened = '';
  try {
    const workspace = createPlanWorkspace({ api: async (...args: unknown[]) => { calls.push(args); }, work: (run: () => unknown) => run(), node, button: (text: string, run: () => Promise<void>) => { buttons.set(text, run); return node('button', text); }, notice() {}, getState: () => ({ actor: { role: 'admin' } }), getOntologyId: () => current.id, refresh: async () => {}, openOntology: async (id: string) => { opened = id; } });
    workspace.ontologyCoverage(current);
    const panel = querySelector('#discovery-coverage');
    const flatten = (el: Element): Element[] => [el, ...el.children.flatMap(flatten)];
    const nodes = flatten(panel), text = nodes.map(n => n.text).join('\n');
    assert.ok(text.includes('是否将上面的“合同管理”作为本实例首次启用'));
    assert.ok(text.includes('金额：decimal'));
    assert.ok(text.includes('发布前还需保存 1 项'));
    const save = buttons.get('确认首次启用并保存决定')!;
    await assert.rejects(save(), /填写本次决定理由/);
    assert.equal(calls.length, 0);
    nodes.find(n => n.tag === 'textarea')!.value = '已确认合同、公司和负责人业务范围';
    await save();
    assert.equal(calls[0][0], '/api/ontologies/draft/review');
    assert.deepEqual(calls[0][1].issueIds, ['first']);
    assert.equal(calls[0][1].expectedRevision, 3);
    assert.equal(opened, 'draft');
  } finally { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); }
});

test('batch identity continuation preserves unsaved exclusions while allowing reason and identity overrides', async () => {
  class Element {
    children: Element[] = []; value = ''; disabled = false; checked = false; type = ''; textContent = ''; className = '';
    listeners = new Map<string, () => void>();
    tag: string; text: string;
    constructor(tag = '', text = '') { this.tag = tag; this.text = text; }
    append(...elements: Element[]) { this.children.push(...elements); }
    replaceChildren(...elements: Element[]) { this.children = elements; }
    addEventListener(event: string, run: () => void) { this.listeners.set(event, run); }
    scrollIntoView() {}
  }
  const elements = new Map<string, Element>();
  const querySelector = (selector: string) => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector)!;
  };
  const flatten = (el: Element): Element[] => [el, ...el.children.flatMap(flatten)];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector } });
  const calls: Array<{ path: string; input: any }> = [], buttons = new Map<string, () => Promise<void>>();
  const current = {
    id: 'plan', revision: 2, status: 'draft', ontology_id: 'draft',
    manifest: [{ id: 'source-version', title: 'Contracts', coverage: {} }],
    proposal: { csv: [], documents: [] }, review: { items: {}, identities: {}, reason: '' },
    preview: { ready: false, errors: [], events: [], outputs: [], identityCandidateHash: 'candidates', identities: [{ key: 'contract', typeId: 'Contract', value: 'C001', participants: [] }] },
  };
  try {
    const workspace = createPlanWorkspace({
      api: async (path: string, input?: unknown) => {
        if (input !== undefined) { calls.push({ path, input }); return { id: 'plan', continuationJobId: 'continue' }; }
        if (path === '/api/plans/plan') return structuredClone(current);
        if (path === '/api/ontologies/draft') return { ...draft(), status: 'published' };
        if (path === '/api/source-versions/source-version') return { content: {} };
        throw new Error(`Unexpected API request: ${path}`);
      },
      work: (run: () => unknown) => run(), node: (tag: string, text = '') => new Element(tag, text),
      button: (text: string, run: () => Promise<void>) => { buttons.set(text, run); return new Element('button', text); },
      notice() {}, getState: () => ({ actor: { role: 'admin' } }), getOntologyId: () => 'draft', refresh: async () => {}, openOntology: async () => {},
    });
    const setReason = () => {
      const reason = flatten(querySelector('#plan-identities')).find(el => el.tag === 'input')!;
      reason.value = '确认本批具体编号'; reason.listeners.get('input')!();
    };
    await workspace.open('plan');
    setReason();
    const exception = flatten(querySelector('#plan-identities')).find(el => el.tag === 'select')!;
    exception.value = 'separate'; exception.listeners.get('change')!();
    await buttons.get('批准本批对应并继续构建')!();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/plans/plan/identities');
    assert.deepEqual(calls[0].input.overrides, { contract: { decision: 'separate', reason: '确认本批具体编号' } });

    await workspace.open('plan');
    setReason();
    const include = flatten(querySelector('#plan-manifest')).find(el => el.type === 'checkbox')!;
    include.checked = false; include.listeners.get('change')!();
    await assert.rejects(buttons.get('批准本批对应并继续构建')!(), /保存|预检|未保存/);
    assert.equal(calls.length, 1, 'unsaved exclusions must not enqueue identity decisions or builds');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});
