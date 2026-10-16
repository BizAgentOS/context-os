import * as THREE from "three";
import { computeOntologyLayout } from "./ontology-space-model.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const ease = value => 1 - Math.pow(1 - value, 3);
const hash = text => [...text].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7);
const vec = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Shared fine-grain finish. The color and lighting stay close to the original pearl spheres.
function createMatteFinish() {
  const size = 128;
  const heights = new Float32Array(size * size);
  const roughness = new Uint8Array(size * size * 4);
  const normals = new Uint8Array(size * size * 4);
  let seed = 2087;
  for (let i = 0; i < heights.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    heights[i] = seed / 4294967295;
    const value = Math.round(195 + heights[i] * 55);
    roughness.set([value, value, value, 255], i * 4);
  }
  const sample = (x, y) => heights[((y + size) % size) * size + (x + size) % size];
  const normal = new THREE.Vector3();
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    normal.set((sample(x - 1, y) - sample(x + 1, y)) * .35,
      (sample(x, y - 1) - sample(x, y + 1)) * .35, 1).normalize();
    normals.set([Math.round((normal.x + 1) * 127.5), Math.round((normal.y + 1) * 127.5), Math.round((normal.z + 1) * 127.5), 255], (y * size + x) * 4);
  }
  const texture = data => {
    const map = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.magFilter = THREE.LinearFilter; map.minFilter = THREE.LinearMipmapLinearFilter;
    map.generateMipmaps = true; map.repeat.set(2, 2); map.needsUpdate = true;
    return map;
  };
  return {roughness: texture(roughness), normal: texture(normals)};
}

// Closed radial curves produce real rounded filaments, including their depth and lighting.
class WaveRingCurve extends THREE.Curve {
  constructor(radius, amplitude, frequency, phase) {
    super(); Object.assign(this, {radius, amplitude, frequency, phase});
  }
  getPoint(t, target = new THREE.Vector3()) {
    const angle = t * Math.PI * 2;
    const {radius, amplitude, frequency, phase} = this;
    const envelope = .85 + Math.sin(angle * 5 + phase) * .15 + Math.cos(angle * 11 - phase) * .1;
    const wave = Math.sin(angle * frequency + phase) * .6 + Math.sin(angle * (frequency * 2 + 3) - phase) * .28 + Math.sin(angle * (frequency * 3 + 7) + phase) * .12;
    const distance = radius + wave * amplitude * envelope;
    return target.set(Math.cos(angle) * distance, Math.sin(angle) * distance, Math.sin(angle * 4 + phase) * amplitude * .22);
  }
}

// Real spheres and camera projection; DOM labels follow the same world coordinates.
export function createOntologyScene(host, graph, { onActivate, onBackground, onUnavailable }) {
  const canvas = document.createElement("canvas");
  canvas.className = "os-webgl";
  canvas.setAttribute("aria-label", "可旋转的三维本体；拖动旋转、滚轮缩放，也可使用节点按钮或查找目录");
  host.append(canvas);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({canvas, antialias: true, alpha: true, powerPreference: "low-power"});
  } catch {
    canvas.remove(); onUnavailable(); return null;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(43, 1, 1, 6000);
  camera.position.set(0, 0, 950);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = .09;
  controls.minDistance = 260;
  controls.maxDistance = 2400;
  controls.minPolarAngle = .6;
  controls.maxPolarAngle = Math.PI - .6;
  controls.rotateSpeed = .35;
  controls.zoomSpeed = .65;
  const ambient = new THREE.HemisphereLight(0xc6d5f4, 0x151626, 1.7);
  scene.add(ambient);
  const keyLight = new THREE.DirectionalLight(0xffffff, 4.5);
  keyLight.position.set(-200, 350, 500);
  keyLight.castShadow = true; keyLight.shadow.mapSize.set(2048, 2048);
  Object.assign(keyLight.shadow.camera, {left: -650, right: 650, top: 650, bottom: -650, near: 1, far: 1800});
  keyLight.shadow.normalBias = .08; keyLight.shadow.bias = -.00015;
  scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x6380bf, 2.5);
  rimLight.position.set(300, -150, -200); scene.add(rimLight);
  const world = new THREE.Group(); scene.add(world);
  const labels = document.createElement("div"); labels.className = "os-labels"; host.append(labels);
  const items = new Map();
  const geometries = new Set();
  const materials = new Set();
  const geometry = value => { geometries.add(value); return value; };
  const material = value => { materials.add(value); return value; };
  const sphereGeometry = geometry(new THREE.SphereGeometry(1, 64, 48));
  const finish = createMatteFinish();
  let width = 1, height = 1, disposed = false, animationId = 0;
  let view = {stage: "global", focus: null, target: null};
  let moving = null, userMoving = false, motion = true, elapsed = 0, previous = performance.now();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const transitionDuration = () => reduced.matches ? 0 : 1050;
  let obstacles = [], obstacleSignature = "", pendingObstacles = "", obstacleChangedAt = 0, lastObstacleCheck = 0;
  const obstacleSelector = ".os-identity,.os-toolbar,.os-utilities,.os-work-entries,.os-legend,.os-local-card,.os-inspector,.os-directory,.interaction,.agent-task-status";
  function readObstacles() {
    const origin = host.getBoundingClientRect();
    return [...(host.closest(".canvas-app") || host.parentElement).querySelectorAll(obstacleSelector)]
      .filter(element => !element.closest("[hidden]") && getComputedStyle(element).visibility !== "hidden")
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.width && rect.height && rect.right > origin.left && rect.bottom > origin.top && rect.left < origin.right && rect.top < origin.bottom)
      .map(rect => ({left: Math.max(0, rect.left - origin.left - 8), top: Math.max(0, rect.top - origin.top - 8),
        right: Math.min(width, rect.right - origin.left + 8), bottom: Math.min(height, rect.bottom - origin.top + 8)}));
  }
  const signature = rects => JSON.stringify(rects.map(rect => Object.values(rect).map(value => Math.round(value / 4))));
  function glow(color, radius) {
    const glowMaterial = material(new THREE.ShaderMaterial({
      uniforms: {tint: {value: new THREE.Color(color)}, opacity: {value: .28}},
      vertexShader: "varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}",
      fragmentShader: "varying vec2 vUv; uniform vec3 tint; uniform float opacity; void main(){float d=length(vUv-.5)*2.; float a=pow(max(0.,1.-d),3.2)*opacity;gl_FragColor=vec4(tint,a);}",
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    const plane = new THREE.Mesh(geometry(new THREE.PlaneGeometry(radius * 7, radius * 7)), glowMaterial);
    plane.renderOrder = -1;
    return plane;
  }
  function createRays(item, radius, connections) {
    const count = connections ? Math.min(40, 8 + connections * 5) : 0;
    if (!count) return null;
    const vertices = [], uvs = [], phases = [];
    for (let i = 0; i < count; i++) {
      const seed = Math.imul(hash(`${item.key}:${i}`) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
      const random = ((seed ^ (seed >>> 16)) >>> 0) / 4294967295;
      const angle = (i + random * .6) / count * Math.PI * 2;
      const start = radius * 1.76, end = start + radius * (.5 + random * 1.4);
      const halfWidth = radius * (.018 + random * .025);
      const corners = [[start, -halfWidth], [end, -halfWidth * 3], [end, halfWidth * 3], [start, halfWidth]];
      for (const index of [0, 1, 2, 0, 2, 3]) {
        const [length, side] = corners[index];
        vertices.push(Math.cos(angle) * length - Math.sin(angle) * side, Math.sin(angle) * length + Math.cos(angle) * side, -radius * .22);
        uvs.push(index === 0 || index === 3 ? 0 : 1, index < 2 ? 0 : 1); phases.push(random * 6.28);
      }
    }
    const beamGeometry = geometry(new THREE.BufferGeometry());
    beamGeometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
    beamGeometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    beamGeometry.setAttribute("phase", new THREE.Float32BufferAttribute(phases, 1));
    const beamMaterial = material(new THREE.ShaderMaterial({
      uniforms: {tint: {value: new THREE.Color(item.color)}, opacity: {value: .5}, time: {value: 0}},
      vertexShader: `attribute float phase; varying vec2 vUv; varying float vPhase;
        void main(){vUv=uv;vPhase=phase;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
      fragmentShader: `varying vec2 vUv; varying float vPhase; uniform vec3 tint; uniform float opacity; uniform float time;
        void main(){float across=pow(max(0.,1.-abs(vUv.y*2.-1.)),1.7);
          float fade=pow(1.-vUv.x,1.8)*smoothstep(0.,.06,vUv.x);
          float pulse=.72+.28*sin(time*.85+vPhase-vUv.x*2.);
          float core=exp(-pow(abs(vUv.y*2.-1.)*10.,2.))*.3;
          gl_FragColor=vec4(mix(tint,vec3(1.),core), (across*.8+core)*fade*pulse*opacity);
          #include <colorspace_fragment>
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
    return new THREE.Mesh(beamGeometry, beamMaterial);
  }
  for (const item of graph.nodes) {
    const group = new THREE.Group();
    const radius = item.primary ? 25 : item.kind === "concept" ? 17 : 7;
    const surface = material(new THREE.MeshPhysicalMaterial({color: item.color, metalness: .16, roughness: .46,
      roughnessMap: finish.roughness, normalMap: finish.normal, normalScale: new THREE.Vector2(.28, .28),
      clearcoat: .3, clearcoatRoughness: .38, emissive: item.color, emissiveIntensity: .1, transparent: true}));
    const sphere = new THREE.Mesh(sphereGeometry, surface); sphere.scale.setScalar(radius);
    sphere.userData.key = item.key;
    sphere.castShadow = true; sphere.receiveShadow = true;
    const aura = glow(item.color, radius);
    group.add(aura, sphere);
    const rings = new THREE.Group();
    const connections = item.neighborCount || 0;
    const layers = item.kind === "concept" ? Math.min(14, connections === 0 ? 2 : 4 + connections * 2) : 1;
    const frequency = Math.min(96, 24 + connections * 6);
    // Denser groups retain a fixed silhouette; more layers fill the gaps rather than enlarge the node.
    for (let i = 0; i < layers; i++) {
      const outer = layers > 1 ? i / (layers - 1) : 0;
      const base = radius * (1.13 + outer * (connections ? .68 : .2));
      const amplitude = radius * (connections ? .005 + outer * outer * .075 : .008);
      const phase = hash(item.key) % 100 / 10 + i * 1.72;
      const path = new WaveRingCurve(base, amplitude, frequency, phase);
      const thickness = radius * (i < 2 ? .027 : i % 3 === 0 ? .021 : .016);
      const ringGeometry = geometry(new THREE.TubeGeometry(path, Math.min(768, frequency * 12), thickness, 6, true));
      const tint = i % 3 === 1 ? "#a4b7db" : i % 3 === 2 ? "#f0afbd" : item.color;
      const ringMaterial = material(new THREE.MeshStandardMaterial({
        color: tint, metalness: .05, roughness: .52, roughnessMap: finish.roughness,
        normalMap: finish.normal, normalScale: new THREE.Vector2(.18, .18),
        emissive: tint, emissiveIntensity: .045, transparent: true, opacity: .96,
      }));
      ringMaterial.userData.restOpacity = .96;
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.position.z = radius * (.1 + Math.sin(i * 1.8) * .05);
      ring.castShadow = true; ring.receiveShadow = true;
      rings.add(ring);
    }
    const rays = createRays(item, radius, connections);
    if (rays) group.add(rays);
    group.add(rings);

    world.add(group);
    const label = document.createElement("button"); label.type = "button"; label.className = `os-node-label os-node-${item.kind}`;
    label.dataset.nodeKey = item.key;
    if (item.kind === "concept") {
      label.dataset.neighborCount = String(connections);
      label.title = `${item.name} · ${connections} 个关联节点，外圈密度随关联数量增加`;
    }
    label.setAttribute("aria-label", `${item.kind === "concept" ? "查看概念" : "查看依据"}：${item.name}`);
    const name = document.createElement("strong"); name.textContent = item.name;
    if (item.kind === "evidence") {
      const category = {web: "网页依据", document: "资料依据", user: "用户陈述"}[item.item.kind] || "定义依据";
      name.textContent = `${category} ${String(graph.evidence.indexOf(item.item) + 1).padStart(2, "0")}`;
      label.title = item.name;
    }
    const caption = document.createElement("span"); caption.textContent = item.kind !== "concept" ? "说明依据" : item.item.helix
      ? `${item.item.helix.entity.rows} 条记录 · ${item.item.helix.entity.members.length > 1 ? `合并 ${item.item.helix.entity.members.length} 源` : "单一来源"}`
      : `${item.degree} 条关系 · ${item.item.mappingStatus === "bound" ? "已映射" : "未映射"}`;
    label.append(name, caption);
    label.onclick = event => { event.stopPropagation(); onActivate(item.key); };
    label.style.setProperty("--node-tint", item.color);
    labels.append(label);
    items.set(item.key, {item, group, sphere, aura, rings, rays, label, caption, radius, home: group.position.clone(), target: group.position.clone(), opacity: 1, targetOpacity: 1, targetScale: 1});
  }
  const links = graph.edges.map((edge, index) => {
    const positions = new Float32Array(41 * 3);
    const lineGeometry = geometry(new LineGeometry());
    lineGeometry.setPositions(positions);
    const color = edge.kind === "relation" ? "#eaa0b0" : "#7994ce";
    const lineMaterial = material(new LineMaterial({color, linewidth: edge.kind === "relation" ? 1.8 : .7, transparent: true, opacity: edge.kind === "relation" ? .65 : .23, depthWrite: false}));
    const line = new Line2(lineGeometry, lineMaterial); line.frustumCulled = false; world.add(line);
    const pulse = new THREE.Mesh(sphereGeometry, material(new THREE.MeshBasicMaterial({color, transparent: true, opacity: .8})));
    pulse.scale.setScalar(edge.kind === "relation" ? 2.2 : 1.3); world.add(pulse);
    const label = document.createElement("button"); label.type = "button"; label.className = "os-edge-label";
    label.textContent = edge.name; label.hidden = true;
    if (edge.kind === "relation") {
      label.setAttribute("aria-label", `查看关系：${edge.name}`);
      label.onclick = event => {event.stopPropagation(); onActivate(edge.key);}; labels.append(label);
    }
    return {edge, line, pulse, positions, label, offset: index * .19};
  });
  function projection(position) {
    const point = position.clone().applyMatrix4(world.matrixWorld).project(camera);
    return {x: (point.x + 1) * width / 2, y: (1 - point.y) * height / 2, visible: point.z > -1 && point.z < 1};
  }
  function resize() {
    const rect = host.getBoundingClientRect();
    width = Math.max(rect.width, 1); height = Math.max(rect.height, 1);
    renderer.setSize(width, height, false);
    for (const link of links) link.line.material.resolution.set(width, height);
    camera.aspect = width / height; camera.updateProjectionMatrix();
    setView(view, true);
  }
  const observer = new ResizeObserver(resize); observer.observe(host);
  function setView(next, immediate = false) {
    view = next;
    const narrow = window.matchMedia("(max-width:720px)").matches;
    const focusKey = `concept:${next.focus}`;
    const selectedKey = next.target?.kind === "foundation_concept" ? `concept:${next.target.member}` : focusKey;
    const connected = new Set([focusKey]);
    for (const link of graph.edges) if (link.from === focusKey || link.to === focusKey) {connected.add(link.from); connected.add(link.to);}
    const distance = 900;
    const units = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance / height;
    obstacles = readObstacles(); obstacleSignature = signature(obstacles); pendingObstacles = obstacleSignature;
    const activeGraph = next.stage === "local" ? {...graph,
      nodes: graph.nodes.filter(item => connected.has(item.key)),
      edges: graph.edges.filter(edge => connected.has(edge.from) && connected.has(edge.to))} : graph;
    const compact = window.matchMedia("(max-width:440px)").matches ? {conceptWidth:48, conceptHeight:44, evidenceSize:12, offset:6, radius:6.5}
      : narrow ? {conceptWidth:60, conceptHeight:60, evidenceSize:14, offset:10, radius:8}
      : window.matchMedia("(max-width:1100px)").matches ? {conceptWidth:124, conceptHeight:92, evidenceSize:18, offset:16, radius:14}
      : {conceptWidth:148, conceptHeight:100, evidenceSize:18, offset:18, radius:16};
    const positions = next.stage === "detail" ? new Map() : computeOntologyLayout(activeGraph, {width, height, obstacles, ...compact});
    for (const item of items.values()) {
      const isFocus = item.item.key === focusKey;
      const position = positions.get(item.item.key);
      if (position) {
        const z = position.z * units, perspective = (distance - z) / distance;
        const y = position.y - (item.item.kind === "concept" ? compact.offset : 0);
        item.home.set((position.x - width / 2) * units * perspective, (height / 2 - y) * units * perspective, z);
      }
      item.target.copy(item.home);
      // Keep the ring and label within the pixel footprint used by the layout solver.
      const radiusPx = item.item.kind === "concept" ? (item.item.primary ? compact.radius * 1.15 : compact.radius) : (narrow ? 4 : 5);
      item.targetScale = radiusPx * units / item.radius;
      item.targetOpacity = next.stage === "local" && !connected.has(item.item.key) ? .08 : 1;
      if (next.stage === "local" && isFocus) item.targetScale *= 1.12;
      if (next.stage === "detail") {
        item.targetOpacity = item.item.key === selectedKey ? 1 : .025;
        if (item.item.key === selectedKey) {
          item.target.set(narrow ? -105 : -width / height * 220, narrow ? 175 : 0, 20);
          item.targetScale = 1.65;
        }
      }
      item.label.classList.toggle("is-focused", next.stage !== "global" && (isFocus || item.item.key === selectedKey));
      item.label.disabled = item.targetOpacity < .2;
      item.labelWidth = 0; item.labelHeight = 0;
      if (immediate) {item.group.position.copy(item.target); item.group.scale.setScalar(item.targetScale); item.opacity = item.targetOpacity;}
    }
    moving = {start: performance.now(), duration: immediate ? 0 : transitionDuration(),
      position: camera.position.clone(), target: controls.target.clone(), toPosition: vec(0, 0, distance), toTarget: vec(0, 0, 0)};
    controls.enableRotate = next.stage !== "detail";
    controls.enablePan = next.stage !== "detail";
  }
  function reflow() {
    const previousMoving = moving;
    setView(view);
    moving = previousMoving;
  }
  const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  function placeLabels() {
    const projected = [...items.values()].map(item => {
      const point = projection(item.group.position);
      const distance = camera.position.distanceTo(item.group.position);
      const depth = -item.group.position.clone().applyMatrix4(world.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z;
      const radius = item.radius * item.group.scale.x * height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(1, depth));
      return {item, point, distance, radius};
    });
    const nodeBounds = projected.filter(({item}) => item.targetOpacity >= .2).map(({item, point, radius}) => ({
      key: item.item.key, left: point.x - radius * 1.8, right: point.x + radius * 1.8,
      top: point.y - radius * 1.8, bottom: point.y + radius * 1.8}));
    const occupied = [...obstacles];
    // Concepts get readable names first. Evidence stays as an accessible small target until hovered/focused.
    projected.sort((a, b) => Number(b.item.label.matches(":hover,:focus-visible")) - Number(a.item.label.matches(":hover,:focus-visible")) ||
      Number(b.item.item.kind === "concept") - Number(a.item.item.kind === "concept"));
    for (const {item, point, distance, radius} of projected) {
      const hidden = !point.visible || item.targetOpacity < .2 || point.x < -50 || point.x > width + 50 || point.y < 0 || point.y > height;
      item.label.hidden = hidden;
      if (hidden) continue;
      const evidence = item.item.kind === "evidence";
      const expanded = item.label.matches(":hover,:focus-visible");
      const labelWidth = evidence ? 22 : (item.labelWidth ||= item.label.offsetWidth);
      const labelHeight = evidence ? 22 : (item.labelHeight ||= item.label.offsetHeight);
      let left = point.x - labelWidth / 2, top = point.y + radius * 1.8 + 3;
      if (evidence) {
        left = point.x - 11; top = point.y - 11;
        if (expanded) {
          const tooltip = item.label.firstElementChild;
          const tooltipWidth = tooltip.offsetWidth, tooltipHeight = tooltip.offsetHeight;
          tooltip.style.left = `${Math.max(4, Math.min(width - tooltipWidth - 4, point.x - tooltipWidth / 2)) - left}px`;
          tooltip.style.top = `${point.y - tooltipHeight - 16 < 4 ? 25 : -tooltipHeight - 4}px`;
        }
      }
      else {
        const candidates = [[left, top], [left, point.y - radius * 1.8 - labelHeight - 3],
          [point.x + radius * 1.8 + 4, point.y - labelHeight / 2], [point.x - radius * 1.8 - labelWidth - 4, point.y - labelHeight / 2],
          [point.x + radius + 4, point.y + radius + 3], [point.x - radius - labelWidth - 4, point.y + radius + 3],
          [point.x + radius + 4, point.y - radius - labelHeight - 3], [point.x - radius - labelWidth - 4, point.y - radius - labelHeight - 3]];
        const blockers = [...occupied, ...nodeBounds.filter(bound => bound.key !== item.item.key)];
        const score = ([x, y]) => {
          const rect = {left: x, top: y, right: x + labelWidth, bottom: y + labelHeight};
          let value = x < 8 || y < 8 || rect.right > width - 8 || rect.bottom > height - 8 ? 100000 : 0;
          for (const b of blockers) if (intersects(rect, b)) value +=
            (Math.min(rect.right,b.right)-Math.max(rect.left,b.left)) * (Math.min(rect.bottom,b.bottom)-Math.max(rect.top,b.top));
          return value;
        };
        const previous = item.labelPlacement ?? 0;
        let best = previous, bestScore = score(candidates[previous]);
        for (let i = 0; i < candidates.length; i++) {const value = score(candidates[i]); if (value + 30 < bestScore) {best = i; bestScore = value;}}
        item.labelPlacement = best;
        [left, top] = candidates[best];
        left = Math.max(4, Math.min(width - labelWidth - 4, left)); top = Math.max(4, Math.min(height - labelHeight - 4, top));
        occupied.push({left, top, right: left + labelWidth, bottom: top + labelHeight});
      }
      if (!evidence && expanded) {
        const caption = item.caption, captionWidth = caption.offsetWidth, captionHeight = caption.offsetHeight;
        caption.style.left = `${Math.max(4, Math.min(width - captionWidth - 4, left + (labelWidth - captionWidth) / 2)) - left}px`;
        caption.style.top = `${top + labelHeight + captionHeight + 6 > height ? -captionHeight - 5 : labelHeight}px`;
      }
      item.label.style.transform = `translate(${left}px,${top}px)`;
      item.label.style.opacity = String(item.opacity);
      item.label.style.zIndex = String(expanded ? 4000 : Math.round(3000 - distance));
    }
    return occupied;
  }
  function frame(now) {
    if (disposed) return;
    animationId = requestAnimationFrame(frame);
    if (document.hidden) {previous = now; return;}
    // Panel resizing does not resize the canvas. Wait until its transition settles before solving again.
    if (now - lastObstacleCheck > 180 && view.stage !== "detail") {
      lastObstacleCheck = now;
      const current = signature(readObstacles());
      if (current !== pendingObstacles) {pendingObstacles = current; obstacleChangedAt = now;}
      else if (current !== obstacleSignature && now - obstacleChangedAt > 180) reflow();
    }
    const dt = Math.min((now - previous) / 1000, .05); previous = now;
    const animate = motion && !reduced.matches;
    if (animate) elapsed += dt;
    if (moving) {
      const ratio = moving.duration ? Math.min((now - moving.start) / moving.duration, 1) : 1;
      camera.position.lerpVectors(moving.position, moving.toPosition, ease(ratio));
      controls.target.lerpVectors(moving.target, moving.toTarget, ease(ratio));
      if (ratio === 1) moving = null;
    }
    controls.update();
    world.rotation.y = animate && view.stage !== "detail" && !userMoving ? Math.sin(elapsed * .09) * .04 : world.rotation.y;
    const alpha = reduced.matches ? 1 : 1 - Math.exp(-dt * 5.5);
    for (const item of items.values()) {
      const bob = animate && view.stage !== "detail" ? Math.sin(elapsed * .55 + hash(item.item.key)) * 3.5 : 0;
      item.group.position.lerp(vec(item.target.x, item.target.y + bob, item.target.z), alpha);
      item.opacity += (item.targetOpacity - item.opacity) * alpha;
      const scale = item.group.scale.x + (item.targetScale - item.group.scale.x) * alpha; item.group.scale.setScalar(scale);
      item.sphere.material.opacity = item.opacity;
      item.rings.quaternion.copy(camera.quaternion);
      item.rings.children.forEach((ring, i) => {
        ring.rotation.z = elapsed * (i % 2 ? -.025 : .02);
        ring.scale.setScalar(1 + Math.sin(elapsed * .85 + i * .9) * .006);
        ring.material.opacity = item.opacity * ring.material.userData.restOpacity;
      });
      if (item.rays) {
        item.rays.quaternion.copy(camera.quaternion);
        item.rays.material.uniforms.opacity.value = item.opacity * .85;
        item.rays.material.uniforms.time.value = elapsed;
      }
      // Transparent background nodes must not cast opaque shadows over the active neighborhood.
      item.sphere.castShadow = item.opacity > .8;
      for (const ring of item.rings.children) ring.castShadow = item.opacity > .8;
      item.aura.quaternion.copy(camera.quaternion);
      item.aura.material.uniforms.opacity.value = item.opacity * (.2 + Math.sin(elapsed * 1.2) * .02);
    }
    world.updateMatrixWorld(true); camera.updateMatrixWorld();
    const labelBounds = placeLabels();
    for (const link of links) {
      const start = items.get(link.edge.from).group.position;
      const end = items.get(link.edge.to).group.position;
      const middle = start.clone().lerp(end, .5); middle.z += link.edge.kind === "relation" ? 10 : 35;
      const curve = new THREE.QuadraticBezierCurve3(start, middle, end);
      for (let i = 0; i <= 40; i++) curve.getPoint(i / 40).toArray(link.positions, i * 3);
      const attributes = link.line.geometry.attributes;
      for (let i = 0; i < 40; i++) {
        const a = i * 3, b = a + 3;
        attributes.instanceStart.setXYZ(i, link.positions[a], link.positions[a + 1], link.positions[a + 2]);
        attributes.instanceEnd.setXYZ(i, link.positions[b], link.positions[b + 1], link.positions[b + 2]);
      }
      attributes.instanceStart.needsUpdate = attributes.instanceEnd.needsUpdate = true;
      const opacity = Math.min(items.get(link.edge.from).opacity, items.get(link.edge.to).opacity);
      link.line.material.opacity = opacity * (link.edge.kind === "relation" ? .62 : .28);
      link.pulse.position.copy(curve.getPoint((elapsed * .11 + link.offset) % 1));
      link.pulse.material.opacity = opacity * .85;
      const showLabel = view.stage === "local" && opacity > .8 && link.edge.kind === "relation";
      link.label.hidden = !showLabel;
      if (showLabel) {
        const point = projection(curve.getPoint(.52));
        const labelWidth = link.label.offsetWidth, labelHeight = link.label.offsetHeight;
        const rect = {left: point.x - labelWidth / 2, right: point.x + labelWidth / 2, top: point.y, bottom: point.y + labelHeight};
        link.label.hidden = !point.visible || rect.left < 8 || rect.right > width - 8 || rect.top < 8 || rect.bottom > height - 8 || labelBounds.some(bound => intersects(rect, bound));
        if (!link.label.hidden) {
          link.label.style.transform = `translate(${rect.left}px,${rect.top}px)`;
          labelBounds.push(rect);
        }
      }
    }
    renderer.render(scene, camera);
  }
  const raycaster = new THREE.Raycaster();
  let pointer = null;
  function pointerDown(event) {pointer = {x: event.clientX, y: event.clientY};}
  function pointerUp(event) {
    if (!pointer || Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 7) {pointer = null; return;}
    pointer = null;
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / width * 2 - 1, -(event.clientY - rect.top) / height * 2 + 1), camera);
    const hit = raycaster.intersectObjects([...items.values()].filter(item => item.targetOpacity > .2).map(item => item.sphere), false)[0];
    if (hit) onActivate(hit.object.userData.key); else onBackground();
  }
  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointerup", pointerUp);
  controls.addEventListener("start", () => { userMoving = true; moving = null; });
  controls.addEventListener("end", () => { userMoving = false; });
  const contextLost = event => {event.preventDefault(); dispose(); onUnavailable();};
  canvas.addEventListener("webglcontextlost", contextLost);
  function dispose() {
    if (disposed) return; disposed = true;
    cancelAnimationFrame(animationId); observer.disconnect(); controls.dispose();
    canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointerup", pointerUp);
    canvas.removeEventListener("webglcontextlost", contextLost);
    for (const item of geometries) item.dispose();
    for (const item of materials) item.dispose();
    finish.roughness.dispose(); finish.normal.dispose(); keyLight.shadow.dispose();
    renderer.dispose(); canvas.remove(); labels.remove();
  }
  resize(); animationId = requestAnimationFrame(frame);
  return {setView, dispose, setMotion(value) {motion = value;},
    zoom(factor) {moving = null; camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target); controls.update();},
    resetCamera() {setView(view);}};
}
