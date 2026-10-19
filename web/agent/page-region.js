/** Patch a page's changed regions without removing focused controls, expanded details or scroll containers. */
export function updateRegion(current, next) {
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) { current.replaceWith(next); return next; }
  if (current.nodeType === 3) { if (current.data !== next.data) current.data = next.data; return current; }
  if (current.nodeType !== 1) return current;
  for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name) && attribute.name !== "open") current.removeAttribute(attribute.name);
  for (const attribute of next.attributes) if (attribute.name !== "open" && current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  for (const handler of ["onclick", "onchange", "oninput", "onsubmit"]) current[handler] = next[handler];
  if ("disabled" in current) current.disabled = next.disabled;
  const old = [...current.childNodes], used = new Set();
  for (const [index, child] of [...next.childNodes].entries()) {
    const key = child.nodeType === 1 && (child.id || child.dataset.regionKey);
    const match = key ? old.find(item => !used.has(item) && item.nodeType === 1 && (item.id || item.dataset.regionKey) === key) : old[index];
    if (match && !used.has(match) && match.nodeName === child.nodeName && !(match.nodeType === 1 && (match.id || match.dataset.regionKey) && !key)) {
      used.add(match); updateRegion(match, child);
      if (current.childNodes[index] !== match) current.insertBefore(match, current.childNodes[index] || null);
    } else current.insertBefore(child, current.childNodes[index] || null);
  }
  for (const child of old) if (!used.has(child) && child.parentNode === current) child.remove();
  return current;
}
