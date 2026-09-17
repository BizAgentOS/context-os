import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Browser modules are native JavaScript.
import { buildOntologyGraph, createOntologyNavigation } from "../../web/agent/ontology-space-model.js";

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
