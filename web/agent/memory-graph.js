const SVG_NS = "http://www.w3.org/2000/svg";
let graphSequence = 0;

function element(tag, className, text) {
  const item = document.createElement(tag);
  item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function svgElement(tag, attributes = {}) {
  const item = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes))
    item.setAttribute(name, String(value));
  return item;
}

// A deterministic spring layout keeps related objects close without a graph dependency.
// Layout does not depend on selection, so reading a node never rearranges the canvas.
function positionsFor(nodes, edges) {
  if (nodes.length === 1)
    return {
      points: new Map([[nodes[0].id, { x: 240, y: 180 }]]),
      width: 480,
      height: 360,
    };
  const positions = nodes.map((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2 - Math.PI / 2;
    return {
      id: node.id,
      x: Math.cos(angle) * 220,
      y: Math.sin(angle) * 160,
      vx: 0,
      vy: 0,
    };
  });
  const byId = new Map(positions.map((point) => [point.id, point]));
  const pairs = new Map();
  for (const edge of edges) {
    if (edge.from === edge.to || !byId.has(edge.from) || !byId.has(edge.to))
      continue;
    const key = JSON.stringify([edge.from, edge.to].sort());
    if (!pairs.has(key))
      pairs.set(key, [byId.get(edge.from), byId.get(edge.to)]);
  }
  for (let iteration = 0; iteration < 440; iteration += 1) {
    const cooling = 1 - iteration / 520;
    for (let i = 0; i < positions.length; i += 1) {
      const a = positions[i];
      for (let j = i + 1; j < positions.length; j += 1) {
        const b = positions[j];
        const dx = b.x - a.x || 0.1;
        const dy = b.y - a.y || 0.1;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = Math.min(12, 10000 / (distance * distance));
        a.vx -= (dx / distance) * force;
        a.vy -= (dy / distance) * force;
        b.vx += (dx / distance) * force;
        b.vy += (dy / distance) * force;
        // Reserve actual label-card space, including room around relation labels.
        const overlapX = 196 - Math.abs(dx);
        const overlapY = 126 - Math.abs(dy);
        if (overlapX > 0 && overlapY > 0) {
          if (overlapX < overlapY) {
            const push = Math.sign(dx) * overlapX * 0.08;
            a.vx -= push;
            b.vx += push;
          } else {
            const push = Math.sign(dy) * overlapY * 0.08;
            a.vy -= push;
            b.vy += push;
          }
        }
      }
    }
    for (const [a, b] of pairs.values()) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const pull = (distance - 228) * 0.021;
      a.vx += (dx / distance) * pull;
      a.vy += (dy / distance) * pull;
      b.vx -= (dx / distance) * pull;
      b.vy -= (dy / distance) * pull;
    }
    for (const point of positions) {
      point.vx = (point.vx - point.x * 0.0015) * 0.72;
      point.vy = (point.vy - point.y * 0.002) * 0.72;
      point.x += point.vx * cooling;
      point.y += point.vy * cooling;
    }
  }
  const left = Math.min(...positions.map((point) => point.x));
  const top = Math.min(...positions.map((point) => point.y));
  const width = Math.max(
    480,
    Math.max(...positions.map((point) => point.x)) - left + 240,
  );
  const height = Math.max(
    360,
    Math.max(...positions.map((point) => point.y)) - top + 180,
  );
  const contentWidth = Math.max(...positions.map((point) => point.x)) - left;
  const contentHeight = Math.max(...positions.map((point) => point.y)) - top;
  for (const point of positions) {
    point.x = point.x - left + (width - contentWidth) / 2;
    point.y = point.y - top + (height - contentHeight) / 2;
  }
  return { points: byId, width, height };
}

function boundary(point, target) {
  const dx = target.x - point.x;
  const dy = target.y - point.y;
  const ratio = Math.min(
    78 / Math.max(0.01, Math.abs(dx)),
    36 / Math.max(0.01, Math.abs(dy)),
  );
  return { x: point.x + dx * ratio, y: point.y + dy * ratio };
}

function selfLoopGeometry(point, index) {
  const start = { x: point.x + 50, y: point.y - 36 };
  const first = {
    x: point.x + 140 + index * 95,
    y: point.y - 140 - index * 90,
  };
  const second = { x: point.x + 155 + index * 95, y: point.y + 30 };
  const end = { x: point.x + 78, y: point.y + 10 };
  const at = (t) => {
    const u = 1 - t;
    return {
      x:
        u ** 3 * start.x +
        3 * u ** 2 * t * first.x +
        3 * u * t ** 2 * second.x +
        t ** 3 * end.x,
      y:
        u ** 3 * start.y +
        3 * u ** 2 * t * first.y +
        3 * u * t ** 2 * second.y +
        t ** 3 * end.y,
    };
  };
  return {
    path: `M ${start.x} ${start.y} C ${first.x} ${first.y}, ${second.x} ${second.y}, ${end.x} ${end.y}`,
    label: at(0.5),
    points: Array.from({ length: 17 }, (_, i) => at(i / 16)),
  };
}

function reserveSelfLoopSpace(layout, edges) {
  const counts = new Map();
  let minX = 0;
  let minY = 0;
  let maxX = layout.width;
  let maxY = layout.height;
  for (const edge of edges) {
    if (edge.from !== edge.to) continue;
    const index = counts.get(edge.from) || 0;
    counts.set(edge.from, index + 1);
    const loop = selfLoopGeometry(layout.points.get(edge.from), index);
    const bounds = [
      ...loop.points,
      { x: loop.label.x - 68, y: loop.label.y - 13 },
      { x: loop.label.x + 68, y: loop.label.y + 13 },
    ];
    for (const point of bounds) {
      minX = Math.min(minX, point.x - 24);
      minY = Math.min(minY, point.y - 24);
      maxX = Math.max(maxX, point.x + 24);
      maxY = Math.max(maxY, point.y + 24);
    }
  }
  for (const point of layout.points.values()) {
    point.x -= minX;
    point.y -= minY;
  }
  layout.width = maxX - minX;
  layout.height = maxY - minY;
}

export function createMemoryGraph({
  nodes = [],
  edges = [],
  selectedId,
  onSelectNode,
  onSelectEdge,
  ariaLabel = "业务关系图",
}) {
  const graph = element("section", "memory-graph");
  graph.updateSelection = () => {};
  graph.setAttribute("aria-label", ariaLabel);
  if (!nodes.length) {
    graph.append(
      element(
        "p",
        "memory-graph-empty",
        "定义保存后，概念与关系会出现在这里。",
      ),
    );
    return graph;
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visibleEdges = edges.filter(
    (edge) => nodeById.has(edge.from) && nodeById.has(edge.to),
  );
  const layout = positionsFor(nodes, visibleEdges);
  reserveSelfLoopSpace(layout, visibleEdges);
  const viewport = element("div", "memory-graph-viewport");
  viewport.tabIndex = 0;
  viewport.setAttribute(
    "aria-label",
    `${ariaLabel}，可以滚动查看，使用缩放按钮调整大小`,
  );
  const extent = element("div", "memory-graph-extent");
  const stage = element("div", "memory-graph-stage");
  stage.style.width = `${layout.width}px`;
  stage.style.height = `${layout.height}px`;
  const svg = svgElement("svg", {
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    "aria-hidden": "true",
    class: "memory-graph-lines",
  });
  const markerId = `memory-arrow-${++graphSequence}`;
  const defs = svgElement("defs");
  const marker = svgElement("marker", {
    id: markerId,
    viewBox: "0 0 8 8",
    refX: 7,
    refY: 4,
    markerWidth: 7,
    markerHeight: 7,
    orient: "auto",
    markerUnits: "userSpaceOnUse",
  });
  marker.append(
    svgElement("path", {
      d: "M1 1 L7 4 L1 7",
      fill: "none",
      stroke: "#939393",
      "stroke-width": 1.2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
  defs.append(marker);
  svg.append(defs);
  stage.append(svg);
  const edgeItems = [];
  const nodeItems = [];
  const groups = new Map();
  for (const edge of visibleEdges) {
    const key = JSON.stringify([edge.from, edge.to].sort());
    const group = groups.get(key) || [];
    group.push(edge);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.forEach((edge, index) => {
      const from = layout.points.get(edge.from);
      const to = layout.points.get(edge.to);
      const path = svgElement("path", {
        class: "memory-graph-edge",
        "marker-end": `url(#${markerId})`,
      });
      let labelPoint;
      if (edge.from === edge.to) {
        const loop = selfLoopGeometry(from, index);
        path.setAttribute("d", loop.path);
        labelPoint = loop.label;
      } else {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.max(1, Math.hypot(dx, dy));
        // Use one canonical normal for both directions so reciprocal labels separate.
        const canonical = edge.from === group[0].from ? 1 : -1;
        const bend =
          group.length > 1
            ? (index - (group.length - 1) / 2) * 84 * canonical
            : 0;
        const control = {
          x: (from.x + to.x) / 2 - (dy / length) * bend,
          y: (from.y + to.y) / 2 + (dx / length) * bend,
        };
        const start = boundary(from, control);
        const end = boundary(to, control);
        path.setAttribute(
          "d",
          `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`,
        );
        labelPoint = {
          x: start.x * 0.25 + control.x * 0.5 + end.x * 0.25,
          y: start.y * 0.25 + control.y * 0.5 + end.y * 0.25,
        };
      }
      svg.append(path);
      const label = element("button", "memory-graph-relation", edge.label);
      label.type = "button";
      label.dataset.edgeId = String(edge.id);
      label.title = `${nodeById.get(edge.from).label} → ${edge.label} → ${nodeById.get(edge.to).label}`;
      label.setAttribute("aria-label", `查看关系 ${label.title}`);
      label.style.left = `${labelPoint.x}px`;
      label.style.top = `${labelPoint.y}px`;
      label.addEventListener("click", () => onSelectEdge?.(edge));
      stage.append(label);
      edgeItems.push({ edge, path, label });
    });
  }
  const select = (id) => {
    for (const { node, button } of nodeItems)
      button.setAttribute("aria-pressed", String(node.id === id));
    const neighbors = new Set([id]);
    for (const { edge, path, label } of edgeItems) {
      const dim = id !== undefined && edge.from !== id && edge.to !== id;
      path.classList.toggle("memory-graph-dimmed", dim);
      label.classList.toggle("memory-graph-dimmed", dim);
      if (!dim) {
        neighbors.add(edge.from);
        neighbors.add(edge.to);
      }
    }
    for (const { node, button } of nodeItems)
      button.classList.toggle(
        "memory-graph-distant",
        id !== undefined && !neighbors.has(node.id),
      );
  };
  graph.updateSelection = select;
  for (const node of nodes) {
    const point = layout.points.get(node.id);
    const button = element("button", "memory-graph-node");
    button.type = "button";
    button.dataset.nodeId = String(node.id);
    if (node.kind) button.dataset.kind = node.kind;
    button.style.left = `${point.x}px`;
    button.style.top = `${point.y}px`;
    button.title = [node.label, node.subtitle].filter(Boolean).join(" · ");
    button.setAttribute("aria-label", `查看 ${button.title}`);
    button.append(element("span", "memory-graph-node-label", node.label));
    if (node.subtitle)
      button.append(
        element("span", "memory-graph-node-subtitle", node.subtitle),
      );
    button.addEventListener("click", () => {
      select(node.id);
      onSelectNode?.(node);
    });
    stage.append(button);
    nodeItems.push({ node, button });
  }
  select(selectedId);
  extent.append(stage);
  viewport.append(extent);
  graph.append(viewport);

  const toolbar = element("div", "memory-graph-toolbar");
  toolbar.append(element("span", "memory-graph-hint", "选择节点或连线查看"));
  const controls = element("div", "memory-graph-controls");
  let zoom = 1;
  let manualZoom = false;
  const zoomLabel = element("span", "memory-graph-zoom", "100%");
  function setZoom(value, center = true) {
    const oldZoom = zoom;
    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / oldZoom;
    const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / oldZoom;
    zoom = Math.max(0.25, Math.min(1.8, value));
    stage.style.transform = `scale(${zoom})`;
    extent.style.width = `${layout.width * zoom}px`;
    extent.style.height = `${layout.height * zoom}px`;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    if (center) {
      viewport.scrollLeft = centerX * zoom - viewport.clientWidth / 2;
      viewport.scrollTop = centerY * zoom - viewport.clientHeight / 2;
    }
  }
  function fit() {
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (!width || !height) return;
    setZoom(Math.min(1, width / layout.width, height / layout.height), false);
    viewport.scrollLeft = 0;
    viewport.scrollTop = 0;
  }
  function control(text, ariaLabel, action) {
    const item = element("button", "memory-graph-control", text);
    item.type = "button";
    item.setAttribute("aria-label", ariaLabel);
    item.title = ariaLabel;
    item.addEventListener("click", action);
    return item;
  }
  controls.append(
    control("−", "缩小关系图", () => {
      manualZoom = true;
      setZoom(zoom / 1.2);
    }),
    zoomLabel,
    control("+", "放大关系图", () => {
      manualZoom = true;
      setZoom(zoom * 1.2);
    }),
    control("适应", "完整显示关系图", () => {
      manualZoom = false;
      fit();
    }),
  );
  toolbar.append(controls);
  graph.append(toolbar);
  const observer = new ResizeObserver(() => {
    if (!manualZoom) fit();
  });
  observer.observe(viewport);
  // The entire workspace can be replaced at once; its parent alone would not see
  // that removal. Disconnect both observers as soon as this graph leaves the page.
  const lifecycle = new MutationObserver(() => {
    if (graph.isConnected) return;
    observer.disconnect();
    lifecycle.disconnect();
  });
  requestAnimationFrame(() => {
    fit();
    if (graph.isConnected)
      lifecycle.observe(graph.ownerDocument.body, {
        childList: true,
        subtree: true,
      });
    else observer.disconnect();
  });
  return graph;
}
