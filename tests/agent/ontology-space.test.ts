import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Browser modules are native JavaScript.
import { buildOntologyGraph, createOntologyNavigation, computeOntologyLayout } from "../../web/agent/ontology-space-model.js";

const foundation = {
  id: "foundation-a", version: 3, status: "candidate",
  content: {
    enterprise: { name: "示例企业" },
    concepts: [
      { id: "customer", name: "客户", evidenceRefs: ["statement"], mappingStatus: "bound" },
      { id: "contract", name: "合同", evidenceRefs: ["statement"], mappingStatus: "unbound" },
      { id: "unlinked", name: "孤立概念", evidenceRefs: [], mappingStatus: "unbound" },
    ],
    relations: [{ id: "signs", name: "签订", from: "customer", to: "contract", evidenceRefs: ["statement"] }],
    evidence: [{ id: "statement", kind: "user", quote: "客户签订合同" }],
    unknowns: [], conflicts: [],
  },
};

test("ontology exploration enters focus and detail by clicks and returns one level without changing facts", () => {
  const before = JSON.stringify(foundation);
  const graph = buildOntologyGraph(foundation);
  const view = createOntologyNavigation(graph);
  assert.equal(view.current.stage, "global");
  view.activate("concept:customer");
  assert.equal(view.current.stage, "local");
  assert.equal(view.current.focus, "customer");
  view.activate("relation:signs");
  assert.equal(view.current.stage, "detail");
  assert.deepEqual(view.current.target, {kind: "foundation_relation", member: "signs"});
  view.back();
  assert.equal(view.current.stage, "local");
  assert.equal(view.current.focus, "customer");
  view.activate("concept:customer");
  assert.equal(view.current.stage, "detail");
  view.back(); view.back();
  assert.equal(view.current.stage, "global");
  view.activate("concept:not-present");
  assert.equal(view.current.stage, "global");
  assert.equal(JSON.stringify(foundation), before);
});

test("the graph preserves isolated concepts and only connects actual relations and evidence references", () => {
  const input = structuredClone(foundation);
  input.content.relations.push({id: "missing", name: "失效关系", from: "customer", to: "removed", evidenceRefs: []});
  const graph = buildOntologyGraph(input);
  assert.deepEqual(graph.stats, {concepts: 3, relations: 1, mapped: 1, evidence: 1});
  assert.deepEqual(graph.edges.map((edge: {key: string}) => edge.key).sort(), ["evidence:contract:statement", "evidence:customer:statement", "relation:signs"]);
  assert.equal(graph.nodes.find((node: {id: string}) => node.id === "unlinked").degree, 0);
  assert.equal(graph.primary, "customer");
  assert.equal(graph.nodes.find((node: {id: string}) => node.id === "customer").target.member, "customer");
});

test("node ring density follows distinct connected concepts, not duplicate relations or evidence", () => {
  const input = structuredClone(foundation);
  input.content.relations.push(
    {id: "manages", name: "管理", from: "customer", to: "contract", evidenceRefs: []},
    {id: "reverse", name: "归属", from: "contract", to: "customer", evidenceRefs: []},
    {id: "self", name: "自身", from: "customer", to: "customer", evidenceRefs: []},
    {id: "invalid", name: "无效", from: "customer", to: "missing", evidenceRefs: []},
  );
  const before = JSON.stringify(input);
  const node = (graph: ReturnType<typeof buildOntologyGraph>, id: string) => graph.nodes.find((item: {id: string}) => item.id === id);
  const graph = buildOntologyGraph(input);
  assert.equal(node(graph, "customer").neighborCount, 1);
  assert.equal(node(graph, "contract").neighborCount, 1);
  assert.equal(node(graph, "unlinked").neighborCount, 0);
  assert.equal(JSON.stringify(input), before);
  input.content.relations.push({id: "new", name: "新增关联", from: "unlinked", to: "customer", evidenceRefs: []});
  const expanded = buildOntologyGraph(input);
  assert.equal(node(expanded, "customer").neighborCount, 2);
  assert.equal(node(expanded, "unlinked").neighborCount, 1);
});

test("stale selections cannot restore removed members, invalid kinds or invalid stages", () => {
  const graph = buildOntologyGraph(foundation);
  for (const saved of [
    {stage: "detail", focus: "removed", target: {kind: "foundation_concept", member: "customer"}},
    {stage: "detail", focus: "customer", target: {kind: "foundation_relation", member: "removed"}},
    {stage: "detail", focus: "customer", target: {kind: "made_up", member: "signs"}},
    {stage: "broken", focus: "customer", target: {kind: "foundation_concept", member: "customer"}},
  ]) assert.equal(createOntologyNavigation(graph, saved).current.stage, "global");
  const nav = createOntologyNavigation(graph);
  nav.activate("evidence:statement");
  assert.equal(nav.current.stage, "detail");
  assert.equal(nav.current.evidenceId, "statement");
  assert.equal(nav.current.target.member, "customer");
  nav.back();
  assert.equal(nav.current.stage, "local");
  assert.equal(nav.current.evidenceId, null);
});

test("following a neighbor's relation keeps its actual endpoint in view and returns to the originating focus", () => {
  const input = structuredClone(foundation);
  input.content.relations.push({id: "next", name: "后续", from: "contract", to: "unlinked", evidenceRefs: []});
  const nav = createOntologyNavigation(buildOntologyGraph(input));
  nav.activate("concept:customer");
  nav.activate("concept:contract");
  nav.activate("relation:next");
  assert.equal(nav.current.focus, "contract");
  assert.equal(nav.current.target.member, "next");
  nav.back();
  assert.equal(nav.current.stage, "local");
  assert.equal(nav.current.focus, "customer");
});


type LayoutPoint = {x: number; y: number; z: number};
type LayoutNode = {key: string; kind: string};
type LayoutObstacle = {left: number; top: number; right: number; bottom: number};

function footprint(node: LayoutNode, point: LayoutPoint): LayoutObstacle {
  const halfWidth = node.kind === "concept" ? 74 : 9;
  const halfHeight = node.kind === "concept" ? 50 : 9;
  return {left: point.x - halfWidth, right: point.x + halfWidth, top: point.y - halfHeight, bottom: point.y + halfHeight};
}

function intersects(a: LayoutObstacle, b: LayoutObstacle) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function denseFoundation() {
  return {content: {
    concepts: Array.from({length: 25}, (_,index) => ({id: `concept-${index}`, name: `业务概念 ${index}`,
      evidenceRefs: Array.from({length: 52}, (_,evidence) => evidence).filter(evidence => evidence % 25 === index || (evidence + 3) % 25 === index).map(evidence => `evidence-${evidence}`)})),
    relations: Array.from({length: 17}, (_,index) => ({id: `relation-${index}`, from: `concept-${index}`, to: `concept-${(index * 3 + 1) % 25}`})),
    evidence: Array.from({length: 52}, (_,index) => ({id: `evidence-${index}`, title: `资料依据 ${index}`})),
  }};
}

test("dense ontology layout separates all 25 concept labels and 52 evidence markers around interface panels", () => {
  const input = denseFoundation();
  const graph = buildOntologyGraph(input);
  const before = JSON.stringify(graph);
  const obstacles = [
    {left: 0, top: 0, right: 260, bottom: 320},
    {left: 540, top: 0, right: 910, bottom: 210},
    {left: 930, top: 570, right: 1440, bottom: 800},
    {left: 0, top: 560, right: 180, bottom: 800},
  ];
  const layout: Map<string, LayoutPoint> = computeOntologyLayout(graph, {width: 1440, height: 800, obstacles});
  assert.equal(layout.size, 77);
  assert.deepEqual(layout, computeOntologyLayout(graph, {width: 1440, height: 800, obstacles}));
  assert.equal(JSON.stringify(graph), before, "layout must not add relations or alter source facts");
  const nodes: LayoutNode[] = graph.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const point = layout.get(nodes[i].key)!;
    const rect = footprint(nodes[i], point);
    assert.ok(rect.left >= 16 && rect.right <= 1424 && rect.top >= 16 && rect.bottom <= 784, nodes[i].key);
    assert.ok(Math.abs(point.z) <= 12);
    for (const block of obstacles) assert.equal(intersects(rect, block), false, `${nodes[i].key} hidden behind panel`);
    for (let j = i + 1; j < nodes.length; j++) {
      assert.equal(intersects(rect, footprint(nodes[j], layout.get(nodes[j].key)!)), false, `${nodes[i].key} overlaps ${nodes[j].key}`);
      if (nodes[i].kind === "concept" && nodes[j].kind === "concept") {
        const neighbor = layout.get(nodes[j].key)!;
        assert.ok(Math.hypot(point.x - neighbor.x, point.y - neighbor.y) >= 100, "concept centres need room for readable labels");
      }
    }
  }
  const concepts = nodes.filter(node => node.kind === "concept").map(node => layout.get(node.key)!);
  assert.ok(Math.max(...concepts.map(point => point.x)) - Math.min(...concepts.map(point => point.x)) > 1000);
  assert.ok(Math.max(...concepts.map(point => point.y)) - Math.min(...concepts.map(point => point.y)) > 550);
});

test("empty and small layouts retain isolated concepts and avoid panels without requiring invented connections", () => {
  assert.deepEqual(computeOntologyLayout({nodes: [], edges: []}, {width: 1000, height: 700}), new Map());
  const graph = buildOntologyGraph(foundation);
  const obstacles = [{left: 300, top: 180, right: 700, bottom: 500}];
  const layout: Map<string, LayoutPoint> = computeOntologyLayout(graph, {width: 1000, height: 700, obstacles});
  assert.deepEqual([...layout.keys()].sort(), graph.nodes.map((node: LayoutNode) => node.key).sort());
  assert.ok(layout.has("concept:unlinked"));
  for (const node of graph.nodes) assert.equal(intersects(footprint(node, layout.get(node.key)!), obstacles[0]), false);
  const point: LayoutPoint = computeOntologyLayout({nodes: [{key: "only", kind: "concept"}], edges: []}, {width: 500, height: 400}).get("only");
  assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
});

test("crowded narrow screens keep every node finite and inside the viewport when full label separation cannot fit", () => {
  const graph = buildOntologyGraph(denseFoundation());
  const obstacles = [{left: 0, top: 0, right: 390, bottom: 120}, {left: 0, top: 550, right: 390, bottom: 700}];
  const layout: Map<string, LayoutPoint> = computeOntologyLayout(graph, {width: 390, height: 700, obstacles});
  assert.equal(layout.size, graph.nodes.length);
  for (const node of graph.nodes) {
    const point = layout.get(node.key)!;
    const rect = footprint(node, point);
    assert.ok([point.x, point.y, point.z].every(Number.isFinite));
    assert.ok(rect.left >= 16 && rect.right <= 374 && rect.top >= 16 && rect.bottom <= 684);
    for (const block of obstacles) assert.equal(intersects(rect, block), false, "crowding must not hide nodes beneath controls");
  }
});

test("responsive footprints reduce crowding in the short graph space between real mobile controls", () => {
  const graph = buildOntologyGraph(denseFoundation());
  const obstacles = [
    {left: 0, top: 0, right: 682, bottom: 220},
    {left: 0, top: 220, right: 682, bottom: 255},
    {left: 16, top: 400, right: 90, bottom: 490},
    {left: 16, top: 565, right: 666, bottom: 760},
    {left: 16, top: 510, right: 666, bottom: 555},
  ];
  const countCollisions = (conceptWidth: number, conceptHeight: number, evidenceSize: number) => {
    const layout: Map<string, LayoutPoint> = computeOntologyLayout(graph, {
      width: 682, height: 780, obstacles, conceptWidth, conceptHeight, evidenceSize,
    });
    const boxes = graph.nodes.map((node: LayoutNode) => {
      const point = layout.get(node.key)!;
      assert.ok([point.x, point.y, point.z].every(Number.isFinite));
      const halfWidth = (node.kind === "concept" ? conceptWidth : evidenceSize) / 2;
      const halfHeight = (node.kind === "concept" ? conceptHeight : evidenceSize) / 2;
      const box = {left: point.x - halfWidth, right: point.x + halfWidth, top: point.y - halfHeight, bottom: point.y + halfHeight};
      assert.ok(box.left >= 16 && box.right <= 666 && box.top >= 16 && box.bottom <= 764);
      for (const block of obstacles) assert.equal(intersects(box, block), false);
      return box;
    });
    assert.equal(layout.size, 77);
    let collisions = 0;
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++)
      if (intersects(boxes[i], boxes[j])) collisions++;
    return collisions;
  };
  const full = countCollisions(148, 100, 18);
  const compact = countCollisions(80, 68, 14);
  const smallest = countCollisions(60, 60, 14);
  // These panels leave too little space for 25 full labels. Resizing improves
  // visibility without silently hiding nodes or pretending all labels fit.
  assert.ok(compact < full / 2, `responsive label collisions ${compact}, full size ${full}`);
  assert.ok(smallest < compact, `smallest label collisions ${smallest}, compact size ${compact}`);
});
