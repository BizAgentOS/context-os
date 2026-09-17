import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const ease = value => 1 - Math.pow(1 - value, 3);
const hash = text => [...text].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7);
const vec = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

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
  const ambient = new THREE.HemisphereLight(0xc8f2ec, 0x151626, 2.2);
  scene.add(ambient);
  const keyLight = new THREE.DirectionalLight(0xffffff, 4.5);
  keyLight.position.set(-200, 350, 500); scene.add(keyLight);
  const rimLight = new THREE.DirectionalLight(0x66bcb5, 2.5);
  rimLight.position.set(300, -150, -200); scene.add(rimLight);
  const world = new THREE.Group(); scene.add(world);
  const labels = document.createElement("div"); labels.className = "os-labels"; host.append(labels);
  const items = new Map();
  const geometries = new Set();
  const materials = new Set();
  const geometry = value => { geometries.add(value); return value; };
  const material = value => { materials.add(value); return value; };
  const sphereGeometry = geometry(new THREE.SphereGeometry(1, 40, 28));
  let width = 1, height = 1, disposed = false, animationId = 0;
  let view = {stage: "global", focus: null, target: null};
  let moving = null, userMoving = false, motion = true, elapsed = 0, previous = performance.now();
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const transitionDuration = () => reduced.matches ? 0 : 1050;
  const globalPositions = new Map();
  const others = graph.nodes.filter(item => !item.primary && item.kind === "concept");
  for (const item of graph.nodes) {
    if (item.primary) globalPositions.set(item.key, vec(-65, 25, 25));
    else if (item.kind === "concept") {
      const index = others.indexOf(item);
      const angle = index / Math.max(others.length, 1) * Math.PI * 2 + .5;
      const ring = 260 + Math.floor(index / 9) * 85;
      globalPositions.set(item.key, vec(Math.cos(angle) * ring * 1.35 - 50, Math.sin(angle) * ring * .65 + 55, Math.sin(angle * 2.1) * 85));
    } else {
      const index = graph.nodes.filter(node => node.kind === "evidence").indexOf(item);
      const angle = index * 2.4 + 2.1;
      globalPositions.set(item.key, vec(Math.cos(angle) * 410 + 30, Math.sin(angle) * 260, -90 + (index % 3) * 65));
    }
  }
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
  for (const item of graph.nodes) {
    const group = new THREE.Group();
    const radius = item.primary ? 25 : item.kind === "concept" ? 17 : 7;
    const surface = material(new THREE.MeshPhysicalMaterial({color: item.color, metalness: .4, roughness: .24,
      clearcoat: 1, clearcoatRoughness: .13, emissive: item.color, emissiveIntensity: .17, transparent: true}));
    const sphere = new THREE.Mesh(sphereGeometry, surface); sphere.scale.setScalar(radius);
    sphere.userData.key = item.key;
    const aura = glow(item.color, radius);
    group.add(aura, sphere);
    const rings = new THREE.Group();
    for (let i = 0; i < (item.kind === "concept" ? 3 : 1); i++) {
      const ring = new THREE.Mesh(geometry(new THREE.TorusGeometry(radius * (1.27 + i * .17), i === 0 ? .65 : .28, 6, 90)),
        material(new THREE.MeshBasicMaterial({color: i === 1 ? 0xbff6e6 : item.color, transparent: true, opacity: i === 0 ? .7 : .28, depthWrite: false})));
      rings.add(ring);
    }
    if (item.kind === "concept") {
      const positions = [];
      for (let i = 0; i < 64; i++) {
        const angle = i / 64 * Math.PI * 2;
        const outer = radius * (1.75 + (i % 4 === 0 ? .17 : .04));
        positions.push(Math.cos(angle) * radius * 1.72, Math.sin(angle) * radius * 1.72, 0,
          Math.cos(angle) * outer, Math.sin(angle) * outer, 0);
      }
      const ticks = new THREE.LineSegments(geometry(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(positions, 3))),
        material(new THREE.LineBasicMaterial({color: item.color, transparent: true, opacity: .4})));
      rings.add(ticks);
    }
    group.add(rings);
    group.position.copy(globalPositions.get(item.key));
    world.add(group);
    const label = document.createElement("button"); label.type = "button"; label.className = `os-node-label os-node-${item.kind}`;
    label.dataset.nodeKey = item.key;
    label.setAttribute("aria-label", `${item.kind === "concept" ? "查看概念" : "查看依据"}：${item.name}`);
    const name = document.createElement("strong"); name.textContent = item.name;
    if (item.kind === "evidence") {
      const category = {web: "网页依据", document: "资料依据", user: "用户陈述"}[item.item.kind] || "定义依据";
      name.textContent = `${category} ${String(graph.evidence.indexOf(item.item) + 1).padStart(2, "0")}`;
      label.title = item.name;
    }
    const caption = document.createElement("span"); caption.textContent = item.kind === "concept" ? `${item.degree} 条关系 · ${item.item.mappingStatus === "bound" ? "已映射" : "未映射"}` : "定义依据";
    label.append(name, caption);
    label.onclick = event => { event.stopPropagation(); onActivate(item.key); };
    label.style.setProperty("--node-tint", item.color);
    labels.append(label);
    items.set(item.key, {item, group, sphere, aura, rings, label, caption, radius, home: group.position.clone(), target: group.position.clone(), opacity: 1, targetOpacity: 1, targetScale: 1});
  }
  const links = graph.edges.map((edge, index) => {
    const positions = new Float32Array(41 * 3);
    const lineGeometry = geometry(new LineGeometry());
    lineGeometry.setPositions(positions);
    const color = edge.kind === "relation" ? "#ead6a0" : "#7ccbc4";
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
    const narrow = width < 720;
    const focusKey = `concept:${next.focus}`;
    const focusX = narrow ? -70 : -width / height * 160;
    const selectedKey = next.target?.kind === "foundation_concept" ? `concept:${next.target.member}` : focusKey;
    const connected = new Set([focusKey]);
    for (const link of graph.edges) if (link.from === focusKey || link.to === focusKey) {connected.add(link.from); connected.add(link.to);}
    const visibleNeighbors = [...items.values()].filter(item => connected.has(item.item.key) && item.item.key !== focusKey);
    for (const item of items.values()) {
      const isFocus = item.item.key === focusKey;
      item.target.copy(item.home);
      if (narrow) item.target.set(item.home.x * .44, item.home.y * .85 + 95, item.home.z);
      item.targetScale = 1; item.targetOpacity = 1;
      if (next.stage === "local") {
        item.targetOpacity = connected.has(item.item.key) ? 1 : .16;
        if (isFocus) {item.target.set(focusX, narrow ? 160 : 145, 55); item.targetScale = 1.25;}
        else if (connected.has(item.item.key)) {
          const index = visibleNeighbors.indexOf(item);
          const angle = (index / Math.max(visibleNeighbors.length, 1)) * Math.PI * 1.7 + .15;
          item.target.set(focusX + Math.cos(angle) * (narrow ? 150 : 260), (narrow ? 160 : 145) + Math.sin(angle) * 160, Math.cos(angle) * 35);
        }
      }
      if (next.stage === "detail") {
        item.targetOpacity = item.item.key === selectedKey ? 1 : .025;
        if (item.item.key === selectedKey) {
          item.target.set(narrow ? -105 : -width / height * 220, narrow ? 175 : 0, 20);
          item.targetScale = 1.65;
        }
      }
      item.label.classList.toggle("is-focused", next.stage !== "global" && (isFocus || item.item.key === selectedKey));
      item.label.disabled = item.targetOpacity < .2;
      item.labelWidth = 0;
    }
    const distance = narrow ? 1250 : 900;
    moving = {start: performance.now(), duration: immediate ? 0 : transitionDuration(),
      position: camera.position.clone(), target: controls.target.clone(), toPosition: vec(0, 0, distance), toTarget: vec(0, 0, 0)};
    controls.enableRotate = next.stage !== "detail";
    controls.enablePan = next.stage !== "detail";
  }
  function frame(now) {
    if (disposed) return;
    animationId = requestAnimationFrame(frame);
    if (document.hidden) {previous = now; return;}
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
      item.rings.rotateZ(animate ? elapsed * .05 : 0);
      item.rings.children.forEach((ring, i) => {ring.material.opacity = item.opacity * (i === 0 ? .75 : .35);});
      item.aura.quaternion.copy(camera.quaternion);
      item.aura.material.uniforms.opacity.value = item.opacity * (.3 + (animate ? Math.sin(elapsed * 1.2) * .04 : 0));
      const point = projection(item.group.position);
      const isHidden = !point.visible || item.targetOpacity < .2 || point.x < -50 || point.x > width + 50 || point.y < 0 || point.y > height - 65;
      item.label.hidden = isHidden;
      if (!isHidden) {
        const distance = camera.position.distanceTo(item.group.position);
        const radiusPx = item.radius * scale * height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * distance);
        const labelWidth = item.labelWidth ||= item.label.offsetWidth;
        const beside = point.x + radiusPx * 1.9;
        const labelX = beside + labelWidth > width - 12 ? Math.max(12, point.x - radiusPx * 1.9 - labelWidth) : beside;
        item.label.style.transform = view.stage === "detail"
          ? `translate(${point.x - 100}px,${point.y - radiusPx * 2.2 - 38}px)`
          : `translate(${labelX}px,${point.y - 17}px)`;
        item.label.style.opacity = String(item.opacity);
        item.label.style.zIndex = String(Math.round(3000 - distance));
      }
    }
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
        link.label.style.transform = `translate(${point.x}px,${point.y}px)`;
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
    renderer.dispose(); canvas.remove(); labels.remove();
  }
  resize(); animationId = requestAnimationFrame(frame);
  return {setView, dispose, setMotion(value) {motion = value;},
    zoom(factor) {moving = null; camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target); controls.update();},
    resetCamera() {setView(view);}};
}
