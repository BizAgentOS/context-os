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
    color: item.id === primary ? "#e9889e" : index % 2 ? "#c0a1ed" : "#e79fbd",
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
      owners: owners.map(owner => owner.id), color: "#83a1d8"});
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

/**
 * Deterministic view-only force layout in screen pixels. Concept points are the
 * centres of label-and-sphere footprints (148 × 100 by default); evidence
 * defaults to 18 × 18. Responsive callers must match these sizes to their CSS.
 * Depth is decorative: all collision and obstacle checks happen in the XY plane.
 */
export function computeOntologyLayout(graph, {width, height, obstacles = [], conceptWidth = 148, conceptHeight = 100, evidenceSize = 18}) {
  const viewportWidth = Math.max(1, Number(width) || 1);
  const viewportHeight = Math.max(1, Number(height) || 1);
  const size = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;
  const nodeWidth = size(conceptWidth, 148);
  const nodeHeight = size(conceptHeight, 100);
  const markerSize = size(evidenceSize, 18);
  const layoutScale = Math.sqrt(nodeWidth * nodeHeight / (148 * 100));
  const margin = 16;
  const gap = 8;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const nodes = [...(graph?.nodes || [])].sort((a, b) => a.key.localeCompare(b.key));
  const count = nodes.length;
  if (!count) return new Map();
  const blocks = obstacles.filter(rect => [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite) &&
    rect.right > rect.left && rect.bottom > rect.top && rect.right > 0 && rect.bottom > 0 &&
    rect.left < viewportWidth && rect.top < viewportHeight).map(rect => ({
    left: Math.max(0, rect.left), top: Math.max(0, rect.top),
    right: Math.min(viewportWidth, rect.right), bottom: Math.min(viewportHeight, rect.bottom),
  }));
  const bodies = nodes.map((node, index) => {
    const concept = node.kind === "concept";
    const radius = Math.sqrt((index + 0.5) / count);
    const angle = index * goldenAngle;
    return {key: node.key, concept, priority: (node.primary ? 10000 : 0) + (node.degree || 0),
      halfWidth: concept ? nodeWidth / 2 : markerSize / 2, halfHeight: concept ? nodeHeight / 2 : markerSize / 2,
      x: viewportWidth * (0.5 + 0.46 * radius * Math.cos(angle)),
      y: viewportHeight * (0.5 + 0.46 * radius * Math.sin(angle)), vx: 0, vy: 0,
      z: Math.sin(index * goldenAngle) * 12};
  });
  const byKey = new Map(bodies.map(body => [body.key, body]));
  const springs = (graph?.edges || []).map(edge => [byKey.get(edge.from), byKey.get(edge.to)])
    .filter(([from, to]) => from && to && from !== to);
  const limits = body => ({
    left: Math.min(viewportWidth / 2, margin + body.halfWidth),
    right: Math.max(viewportWidth / 2, viewportWidth - margin - body.halfWidth),
    top: Math.min(viewportHeight / 2, margin + body.halfHeight),
    bottom: Math.max(viewportHeight / 2, viewportHeight - margin - body.halfHeight),
  });
  const clamp = body => {
    const box = limits(body);
    body.x = Math.max(box.left, Math.min(box.right, body.x));
    body.y = Math.max(box.top, Math.min(box.bottom, body.y));
  };
  const footprint = body => ({left: body.x - body.halfWidth, right: body.x + body.halfWidth,
    top: body.y - body.halfHeight, bottom: body.y + body.halfHeight});
  const overlap = (a, b, padding = gap) => ({
    x: Math.min(a.right, b.right) - Math.max(a.left, b.left) + padding,
    y: Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) + padding,
  });
  const avoidObstacles = body => {
    for (const block of blocks) {
      const box = footprint(body);
      const hit = overlap(box, block);
      if (hit.x <= 0 || hit.y <= 0) continue;
      const bounds = limits(body);
      const exits = [
        {x: block.left - gap - body.halfWidth, y: body.y},
        {x: block.right + gap + body.halfWidth, y: body.y},
        {x: body.x, y: block.top - gap - body.halfHeight},
        {x: body.x, y: block.bottom + gap + body.halfHeight},
      ].filter(point => point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom);
      exits.sort((a, b) => Math.hypot(a.x - body.x, a.y - body.y) - Math.hypot(b.x - body.x, b.y - body.y));
      if (exits[0]) Object.assign(body, exits[0]);
    }
  };
  bodies.forEach(clamp);
  // Springs follow only the graph's actual relation/evidence edges. Repulsion
  // also applies to disconnected nodes, so no concept disappears into a cluster.
  for (let iteration = 0; iteration < 240; iteration++) {
    const cooling = 1 - iteration / 270;
    for (const body of bodies) {
      body.vx = body.vx * 0.66 + (viewportWidth / 2 - body.x) * 0.0006;
      body.vy = body.vy * 0.66 + (viewportHeight / 2 - body.y) * 0.0006;
    }
    for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) {
      const a = bodies[i], b = bodies[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      if (Math.abs(dx) + Math.abs(dy) < 0.01) {
        dx = Math.cos((i + j) * goldenAngle); dy = Math.sin((i + j) * goldenAngle);
      }
      const distance = Math.max(1, Math.hypot(dx, dy));
      const force = Math.min(5, Math.sqrt((a.concept ? 8000 : 1500) * (b.concept ? 8000 : 1500)) * layoutScale ** 2 / (distance * distance));
      const fx = dx / distance * force, fy = dy / distance * force;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      const hit = overlap(footprint(a), footprint(b));
      if (hit.x > 0 && hit.y > 0) {
        if (hit.x < hit.y) {
          const push = Math.sign(dx || 1) * hit.x * 0.12;
          a.vx += push; b.vx -= push;
        } else {
          const push = Math.sign(dy || 1) * hit.y * 0.12;
          a.vy += push; b.vy -= push;
        }
      }
    }
    for (const [a, b] of springs) {
      const dx = b.x - a.x, dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired = (a.concept && b.concept ? 210 : 115) * layoutScale;
      const strength = a.concept && b.concept ? 0.012 : 0.006;
      const force = (distance - desired) * strength;
      const fx = dx / distance * force, fy = dy / distance * force;
      a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
    }
    for (const body of bodies) {
      body.x += Math.max(-12, Math.min(12, body.vx)) * cooling;
      body.y += Math.max(-12, Math.min(12, body.vy)) * cooling;
      clamp(body); avoidObstacles(body);
    }
  }
  // Finish at actual non-overlapping screen positions rather than relying on
  // depth or an animation eventually separating labels. Place larger concepts
  // first, then fit evidence into the remaining gaps near their spring targets.
  const placed = [];
  const order = [...bodies].sort((a, b) => Number(b.concept) - Number(a.concept) || b.priority - a.priority || a.key.localeCompare(b.key));
  for (const body of order) {
    const occupied = [...blocks, ...placed.map(footprint)];
    const bounds = limits(body);
    const desiredX = body.x, desiredY = body.y;
    const scoreAt = (x, y, limit) => {
      const rect = {left: x - body.halfWidth, right: x + body.halfWidth, top: y - body.halfHeight, bottom: y + body.halfHeight};
      let area = 0, blocked = 0;
      for (let index = 0; index < occupied.length; index++) {
        const hit = overlap(rect, occupied[index]);
        if (hit.x > 0 && hit.y > 0) {
          if (index < blocks.length) blocked += hit.x * hit.y;
          else area += hit.x * hit.y;
        }
        if (limit && (blocked > limit.blocked ||
          (index >= blocks.length && blocked === limit.blocked && area > limit.area))) break;
      }
      return {area, blocked};
    };
    let best = {x: desiredX, y: desiredY, ...scoreAt(desiredX, desiredY), distance: 0};
    if (best.blocked > 0 || best.area > 0) {
      const step = body.concept ? 12 : 9;
      const xs = [bounds.left, bounds.right, desiredX];
      const ys = [bounds.top, bounds.bottom, desiredY];
      for (let x = bounds.left + step; x < bounds.right; x += step) xs.push(x);
      for (let y = bounds.top + step; y < bounds.bottom; y += step) ys.push(y);
      // Exact neighboring edges preserve narrow free slots that the sampling
      // grid can miss, especially between responsive controls and labels.
      for (const block of occupied) {
        for (const x of [block.left - gap - body.halfWidth, block.right + gap + body.halfWidth])
          if (x >= bounds.left && x <= bounds.right) xs.push(x);
        for (const y of [block.top - gap - body.halfHeight, block.bottom + gap + body.halfHeight])
          if (y >= bounds.top && y <= bounds.bottom) ys.push(y);
      }
      const candidateXs = [...new Set(xs)].sort((a, b) => Math.abs(a - desiredX) - Math.abs(b - desiredX));
      const candidateYs = [...new Set(ys)].sort((a, b) => Math.abs(a - desiredY) - Math.abs(b - desiredY));
      for (const y of candidateYs) for (const x of candidateXs) {
        const distance = (x - desiredX) ** 2 + (y - desiredY) ** 2;
        if (best.blocked === 0 && best.area === 0 && distance >= best.distance) continue;
        const {area, blocked} = scoreAt(x, y, best);
        // Even on a crowded screen, visible nodes take precedence over placing
        // their labels under a toolbar or the Agent composer.
        if (blocked < best.blocked || (blocked === best.blocked &&
          (area < best.area || (area === best.area && distance < best.distance)))) best = {x, y, area, blocked, distance};
      }
      body.x = best.x; body.y = best.y;
    }
    // On viewports too small for every fixed-size label, the minimum-overlap
    // fallback retains every node at finite, in-bounds coordinates for zooming.
    placed.push(body);
  }
  return new Map(bodies.map(({key, x, y, z}) => [key, {x, y, z}]));
}
