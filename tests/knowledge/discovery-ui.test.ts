import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser JavaScript is verified separately with node --check.
import { createPlanWorkspace, discoveryDecisionState, submitDiscovery } from '../../web/knowledge/plans.js';

test('discovery action reports an old backend beside the button without creating a model task', async () => {
  const messages: Array<{message:string;error:boolean}> = [];
  let requests=0;
  await submitDiscovery({getState:()=>({model:'fixture',ontologies:[]}),selectedSourceVersions:()=>Array(21).fill('version'),baseOntologyId:()=>'',useBase:()=>false,
    api:async()=>{requests++;},refresh:async()=>{},feedback:(message:string,error=false)=>messages.push({message,error})});
  assert.equal(requests,0);assert.match(messages.at(-1)!.message,/旧进程.*重启/);assert.equal(messages.at(-1)!.error,true);
});

test('discovery action accepts 21 selected sources and immediately displays its persisted job ID', async () => {
  const messages:string[]=[],calls:any[]=[];
  const result=await submitDiscovery({getState:()=>({model:'fixture',maxSourceAssets:50,ontologies:[]}),selectedSourceVersions:()=>Array.from({length:21},(_,i)=>`version-${i}`),baseOntologyId:()=>'',useBase:()=>false,
    api:async(path:string,input:any)=>{calls.push({path,input});return {id:'saved-job'};},refresh:async()=>{},feedback:(message:string)=>messages.push(message)});
  assert.equal(result.id,'saved-job');assert.equal(calls.length,1);assert.equal(calls[0].input.sourceVersionIds.length,21);
  assert.match(messages[0],/正在提交 21/);assert.match(messages.at(-1)!,/saved-job/);
});

test('discovery refresh failure preserves accepted job feedback rather than suggesting another submission', async () => {
  const messages:string[]=[];let requests=0;
  const result=await submitDiscovery({getState:()=>({model:'fixture',maxSourceAssets:50,ontologies:[]}),selectedSourceVersions:()=>['version'],baseOntologyId:()=>'',useBase:()=>false,
    api:async()=>{requests++;return {id:'accepted-job'};},refresh:async()=>{throw new Error('network unavailable');},feedback:(message:string)=>messages.push(message)});
  assert.equal(requests,1);assert.equal(result.id,'accepted-job');assert.match(messages.at(-1)!,/已创建.*accepted-job.*刷新失败/);assert.match(messages.at(-1)!,/不要重复生成/);
});

test('discovery transport failure leaves submission unconfirmed rather than claiming no job was created', async () => {
  const messages:string[]=[];let operationId='';
  await submitDiscovery({getState:()=>({model:'fixture',maxSourceAssets:50,ontologies:[]}),selectedSourceVersions:()=>['version'],baseOntologyId:()=>'',useBase:()=>false,
    api:async(_path:string,input:any)=>{operationId=input.operationId;throw new Error('response lost');},refresh:async()=>{},feedback:(message:string)=>messages.push(message)});
  assert.ok(operationId);assert.match(messages.at(-1)!,/提交结果尚未确认/);assert.ok(messages.at(-1)!.includes(operationId));assert.doesNotMatch(messages.at(-1)!,/未创建/);
});

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
    proposal: { csv: [{sourceVersionId:'source-version',objects:[{id:'contract',typeId:'Contract',identityColumn:'id'}],properties:[],links:[]}], documents: [] }, review: { items: {}, identities: {}, reason: '' },
    preview: { ready: false, errors: [], events: [], outputs: [], identityCandidateHash: 'candidates', identities: [{ key: 'contract', typeId: 'Contract', value: 'C001', participants: [] }] },
  };
  try {
    const workspace = createPlanWorkspace({
      api: async (path: string, input?: unknown) => {
        if (input !== undefined) { calls.push({ path, input }); return { id: 'plan', continuationJobId: 'continue' }; }
        if (path === '/api/plans/plan') return structuredClone(current);
        if (path === '/api/ontologies/draft') return { ...draft(), status: 'published' };
        if (path === '/api/source-versions/source-version') return { content: {kind:'table',columns:['id']} };
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
    assert.ok(flatten(querySelector('#plan-bindings')).some(el=>el.text==='数据库表 · Contracts'));
    assert.ok(!flatten(querySelector('#plan-bindings')).some(el=>el.text.startsWith('CSV ·')));
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

    await workspace.open('plan');setReason();
    const offset=flatten(querySelector('#plan-manifest')).find(el=>el.tag==='input'&&el.type==='text')!;
    offset.value='+08:00';offset.listeners.get('change')!();
    await assert.rejects(buttons.get('批准本批对应并继续构建')!(), /时区.*未保存/);
    assert.equal(calls.length,1,'unsaved timezone must not be discarded by identity continuation');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});
