// A view projection of one foundation version. No inferred business relations.
export function buildOntologyGraph(artifact) {
  const content = artifact?.content || {};
  const concepts = content.concepts || [];
  const evidence = content.evidence || [];
  const conceptIds = new Set(concepts.map(item => item.id));
  const relations = (content.relations || []).filter(item => conceptIds.has(item.from) && conceptIds.has(item.to));
  const degree = new Map(concepts.map(item => [item.id, 0]));
  const neighbors = new Map(concepts.map(item => [item.id, new Set()]));
  for (const relation of relations) {
    degree.set(relation.from, degree.get(relation.from) + 1);
    degree.set(relation.to, degree.get(relation.to) + 1);
    if (relation.from !== relation.to) {
      neighbors.get(relation.from).add(relation.to);
      neighbors.get(relation.to).add(relation.from);
    }
  }
  const primary = [...concepts].sort((a, b) => degree.get(b.id) - degree.get(a.id))[0]?.id;
  const nodes = concepts.map((item, index) => ({
    key: `concept:${item.id}`, id: item.id, kind: "concept", name: item.name,
    item, degree: degree.get(item.id), neighborCount: neighbors.get(item.id).size, primary: item.id === primary,
    color: item.id === primary ? "#e9c988" : index % 2 ? "#c0a1ed" : "#e79fbd",
    target: {kind: "foundation_concept", member: item.id},
  }));
  const edges = relations.map(item => ({
    key: `relation:${item.id}`, kind: "relation", name: item.name, item,
    from: `concept:${item.from}`, to: `concept:${item.to}`,
    target: {kind: "foundation_relation", member: item.id},
  }));
  for (const item of evidence) {
    const owners = concepts.filter(concept => concept.evidenceRefs?.includes(item.id));
    if (!owners.length) continue;
    nodes.push({key: `evidence:${item.id}`, id: item.id, kind: "evidence", name: item.title || "用户陈述", item,
      owners: owners.map(owner => owner.id), color: "#86d5bd"});
    for (const owner of owners) edges.push({key: `evidence:${owner.id}:${item.id}`, kind: "evidence",
      name: "定义依据", from: `concept:${owner.id}`, to: `evidence:${item.id}`, item});
  }
  return {artifact, nodes, edges, concepts, relations, evidence, primary,
    stats: {concepts: concepts.length, relations: relations.length,
      mapped: concepts.filter(item => item.mappingStatus === "bound").length,
      evidence: evidence.length}};
}

export function createOntologyNavigation(graph, saved) {
  const knownConcept = id => graph.concepts.some(item => item.id === id);
  const valid = saved && ["local", "detail"].includes(saved.stage) && knownConcept(saved.focus) &&
    (saved.target && (saved.target.kind === "foundation_concept" ? knownConcept(saved.target.member) : saved.target.kind === "foundation_relation" && graph.relations.some(item => item.id === saved.target.member))) &&
    (!saved.returnFocus || knownConcept(saved.returnFocus)) &&
    (!saved.evidenceId || graph.evidence.some(item => item.id === saved.evidenceId));
  let current = valid ? {...saved} : {stage: "global", focus: null, target: null, evidenceId: null};
  const reset = () => current = {stage: "global", focus: null, target: null, evidenceId: null};
  return {
    get current() { return {...current}; },
    activate(key) {
      const entry = graph.nodes.find(node => node.key === key) || graph.edges.find(edge => edge.key === key && edge.kind === "relation");
      if (!entry) return current;
      const returnFocus = current.returnFocus || current.focus;
      if (entry.kind === "concept") {
        current = current.stage === "global"
          ? {stage: "local", focus: entry.id, target: entry.target, evidenceId: null}
          : {stage: "detail", focus: entry.id, returnFocus, target: entry.target, evidenceId: null};
      } else if (entry.kind === "relation") {
        const focus = [entry.item.from, entry.item.to].includes(current.focus) ? current.focus : entry.item.from;
        current = {stage: "detail", focus, returnFocus: returnFocus || focus, target: entry.target, evidenceId: null};
      } else {
        const owner = entry.owners.includes(current.focus) ? current.focus : entry.owners[0];
        current = {stage: "detail", focus: owner, returnFocus: returnFocus || owner, target: {kind: "foundation_concept", member: owner}, evidenceId: entry.id};
      }
      return current;
    },
    focus(id) {
      if (knownConcept(id)) current = {stage: "local", focus: id, target: {kind: "foundation_concept", member: id}, evidenceId: null};
      return current;
    },
    back() {
      if (current.stage === "detail") {
        const focus = current.returnFocus || current.focus;
        current = {stage: "local", focus, target: {kind: "foundation_concept", member: focus}, evidenceId: null};
      }
      else reset();
      return current;
    },
    reset,
  };
}
