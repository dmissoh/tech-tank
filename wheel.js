// Tech Tank — Sunburst Wheel
// Interactive radial visualization of tools by cluster → category → tool.
// Uses only d3.hierarchy + d3.partition from the vendored d3-hierarchy;
// SVG creation, arc paths, and transitions are all vanilla JS.

const DEFAULT_TOOLS = "data/tool_landscape_live.csv";
const DEFAULT_CATS = "data/tool_categories.csv";
const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);
const params = () => new URLSearchParams(location.search);

let TOOLS = [], CATS = [];
let allArcs = [];
let svgEl, gEl, root, radius;
let currentZoom = null; // track zoom state
let zoomStack = []; // history for step-back navigation

// ---- helpers ----
const num = (t) => { const n = Number(t.score); return Number.isFinite(n) ? n : 0; };
const isTrue = (v) => String(v).toLowerCase() === "true";
const weight = (t) => Math.log10(num(t) + 1);
const human = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M"; if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k"; return String(n); };
const stars = (t) => (num(t) > 0 ? "★ " + human(num(t)) : "—");
const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const titleCase = (s) => (s || "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const catRow = (cat) => CATS.find((c) => c.category === cat && !c.subcategory_id);
const clusterOf = (cat) => (catRow(cat) || {}).cluster || "other";

function rel(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(+d)) return "—";
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days < 1) return "today";
  if (days < 30) return `${days}d ago`;
  const mo = Math.floor(days / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(mo / 12), m = mo % 12;
  return `${y}y${m ? ` ${m}mo` : ""} ago`;
}

// ---- cluster colors (oklch) ----
const CLUSTER_COLORS = {
  "agent-layer":    { light: "oklch(0.78 0.10 30)",  dark: "oklch(0.58 0.18 30)" },
  "runtime-stack":  { light: "oklch(0.75 0.10 250)", dark: "oklch(0.54 0.17 250)" },
  "platform-infra": { light: "oklch(0.78 0.08 160)", dark: "oklch(0.58 0.15 160)" },
  "modalities":     { light: "oklch(0.78 0.10 300)", dark: "oklch(0.58 0.18 300)" },
  "discovery":      { light: "oklch(0.82 0.09 85)",  dark: "oklch(0.64 0.16 85)" },
  "domains":        { light: "oklch(0.74 0.08 140)", dark: "oklch(0.54 0.13 140)" },
  "other":          { light: "oklch(0.76 0.04 60)",  dark: "oklch(0.56 0.08 60)" },
};

function clusterColor(cluster, depth) {
  const isDark = document.documentElement.dataset.theme === "dark";
  const pal = CLUSTER_COLORS[cluster] || CLUSTER_COLORS["other"];
  const base = isDark ? pal.dark : pal.light;
  // Lighten for outer rings: parse the oklch lightness and bump it
  if (depth <= 0) return base;
  const m = base.match(/oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/);
  if (!m) return base;
  const l = Math.min(0.92, Number(m[1]) + 0.08 * depth);
  return "oklch(" + l + " " + m[2] + " " + m[3] + ")";
}

// ---- CSV ----
const parseCsv = (text) => Papa.parse(text.trim(), { header: true, skipEmptyLines: true }).data;
async function fetchCsv(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return parseCsv(await r.text());
}

// ---- hierarchy ----
function buildHierarchy(tools) {
  const byCluster = new Map();
  for (const t of tools) {
    const cl = clusterOf(t.category);
    if (!byCluster.has(cl)) byCluster.set(cl, new Map());
    const byCat = byCluster.get(cl);
    if (!byCat.has(t.category)) byCat.set(t.category, []);
    byCat.get(t.category).push(t);
  }
  return {
    name: "Tech Tank",
    children: [...byCluster].map(([cl, byCat]) => ({
      name: titleCase(cl),
      cluster: cl,
      children: [...byCat].map(([cat, items]) => ({
        name: cat,
        cluster: cl,
        children: items.map((t) => ({
          name: t.name,
          value: Math.max(weight(t), 0.04),
          tool: t,
        })),
      })),
    })),
  };
}

// ---- SVG arc path (vanilla math) ----
function arcPath(x0, x1, y0, y1, padAngle) {
  const r0 = Math.max(0, y0);
  const r1 = Math.max(0, y1 - 1);
  if (!(r1 > 0) || !(x1 > x0) || isNaN(x0) || isNaN(x1) || isNaN(y0) || isNaN(y1)) return "";
  const a0 = x0 + padAngle;
  const a1 = x1 - padAngle;
  const sa = Math.sin(a0), ca = Math.cos(a0);
  const sb = Math.sin(a1), cb = Math.cos(a1);
  const large = (a1 - a0) > Math.PI ? 1 : 0;
  return [
    `M${sa * r0},${-ca * r0}`,
    `A${r0},${r0} 0 ${large} 1 ${sb * r0},${-cb * r0}`,
    `L${sb * r1},${-cb * r1}`,
    `A${r1},${r1} 0 ${large} 0 ${sa * r1},${-ca * r1}`,
    "Z",
  ].join(" ");
}

// ---- linear interpolation helper ----
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- animate helper ----
let zoomAnimId = null;

function animate(duration, onFrame) {
  // Cancel any ongoing zoom animation
  if (zoomAnimId) {
    cancelAnimationFrame(zoomAnimId);
    zoomAnimId = null;
  }
  const start = performance.now();
  function tick(now) {
    const t = clamp((now - start) / duration, 0, 1);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    onFrame(eased, t >= 1);
    if (t < 1) {
      zoomAnimId = requestAnimationFrame(tick);
    } else {
      zoomAnimId = null;
    }
  }
  zoomAnimId = requestAnimationFrame(tick);
}

// ---- drag-to-rotate ----
let wheelAngle = 0;
let dragStart = null;
let dragVelocity = 0;
let momentumRaf = null;

function angleFromCenter(clientX, clientY) {
  const rect = svgEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return Math.atan2(clientY - cy, clientX - cx);
}

function applyWheelRotation() {
  gEl.setAttribute("transform", "translate(" + radius + "," + radius + ") rotate(" + (wheelAngle * 180 / Math.PI) + ")");
}

function onDragStart(clientX, clientY) {
  cancelMomentum();
  dragStart = angleFromCenter(clientX, clientY);
  dragVelocity = 0;
}

function onDragMove(clientX, clientY) {
  if (dragStart === null) return;
  const current = angleFromCenter(clientX, clientY);
  let delta = current - dragStart;
  // Normalize delta to [-π, π] to avoid jumps at ±π boundary
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  dragVelocity = delta;
  wheelAngle += delta;
  dragStart = current;
  applyWheelRotation();
}

function onDragEnd() {
  dragStart = null;
  // Start momentum
  if (Math.abs(dragVelocity) > 0.001) {
    let v = dragVelocity * 0.6; // dampen
    function tick() {
      v *= 0.95; // friction
      if (Math.abs(v) < 0.0002) return;
      wheelAngle += v;
      applyWheelRotation();
      momentumRaf = requestAnimationFrame(tick);
    }
    momentumRaf = requestAnimationFrame(tick);
  }
}

function cancelMomentum() {
  if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = null; }
}

// ---- sunburst render ----
function renderSunburst(tools) {
  const data = buildHierarchy(tools);
  const w = Math.min(window.innerWidth - 820, window.innerHeight - 180, 700);
  radius = Math.max(210, Math.min(350, w / 2));
  const size = radius * 2;

  const container = $("sunburst");
  container.innerHTML = "";

  // Create SVG
  svgEl = document.createElementNS(SVG_NS, "svg");
  svgEl.setAttribute("width", size);
  svgEl.setAttribute("height", size);
  svgEl.style.display = "block";
  svgEl.style.cursor = "grab";
  container.appendChild(svgEl);

  // Drag-to-rotate
  svgEl.addEventListener("mousedown", (e) => { e.preventDefault(); onDragStart(e.clientX, e.clientY); });
  svgEl.addEventListener("touchstart", (e) => { if (e.touches.length === 1) { e.preventDefault(); onDragStart(e.touches[0].clientX, e.touches[0].clientY); } }, { passive: false });
  window.addEventListener("mousemove", (e) => onDragMove(e.clientX, e.clientY));
  window.addEventListener("touchmove", (e) => { if (e.touches.length === 1) onDragMove(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  window.addEventListener("mouseup", onDragEnd);
  window.addEventListener("touchend", onDragEnd);

  gEl = document.createElementNS(SVG_NS, "g");
  gEl.setAttribute("transform", `translate(${radius},${radius})`);
  svgEl.appendChild(gEl);

  // Build hierarchy with d3
  root = d3.hierarchy(data)
    .sum((d) => d.value || 0)
    .sort((a, b) => b.value - a.value);

  d3.partition().size([2 * Math.PI, radius])(root);

  currentZoom = root;
  zoomStack = [];
  allArcs = [];
  wheelAngle = 0;

  // Render arcs
  const descendants = root.descendants().filter((d) => d.depth > 0);
  for (const d of descendants) {
    const path = document.createElementNS(SVG_NS, "path");
    const cl = d.data.cluster || (d.depth === 1 ? d.data.cluster : d.parent?.data?.cluster) || "other";
    const padAngle = d.depth === 3 ? 0.002 : 0.005;
    path.setAttribute("d", arcPath(d.x0, d.x1, d.y0, d.y1, padAngle));
    path.setAttribute("fill", clusterColor(cl, d.depth - currentZoom.depth));
    path.setAttribute("class", "sunburst-arc");
    path.setAttribute("data-cluster", cl);
    path.dataset.nodeId = d.data.name;

    path.addEventListener("mouseenter", (e) => onHover(e, d));
    path.addEventListener("mousemove", onMove);
    path.addEventListener("mouseleave", onLeave);
    path.addEventListener("click", () => onClickArc(d));

    gEl.appendChild(path);
    d._el = path; // store reference for zoom animation

    // Per-arc overview label (depth >= 2; depth-1 clusters use the styled cluster-label).
    // Tiny font, truncated to fit the wedge, so the wheel reads as an overview.
    let label = null;
    if (d.depth >= 2) {
      const midAngle = (d.x0 + d.x1) / 2;
      const midR = (d.y0 + d.y1) / 2;
      const lx = Math.sin(midAngle) * midR;
      const ly = -Math.cos(midAngle) * midR;
      const bandW = d.y1 - d.y0;
      const arcLen = midR * (d.x1 - d.x0);
      const fontSize = d.depth === 3 ? 5 : 6;
      const charW = fontSize * 0.62;
      const maxChars = Math.max(2, Math.floor(arcLen / charW) - 1);
      let labelText = d.data.name;
      if (labelText.length > maxChars) labelText = labelText.slice(0, Math.max(1, maxChars - 1)) + "…";
      const deg = midAngle * 180 / Math.PI;
      const flip = deg > 90 && deg < 270;
      label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("x", lx);
      label.setAttribute("y", ly);
      label.setAttribute("transform", `rotate(${flip ? deg + 180 : deg} ${lx} ${ly})`);
      label.setAttribute("text-anchor", "middle");
      label.setAttribute("dominant-baseline", "central");
      label.setAttribute("fill", "#fff");
      label.setAttribute("paint-order", "stroke");
      label.setAttribute("stroke", "rgba(0,0,0,0.5)");
      label.setAttribute("stroke-width", "1.6px");
      label.setAttribute("stroke-linejoin", "round");
      label.setAttribute("font-size", fontSize + "px");
      label.setAttribute("font-family", "var(--mono)");
      label.setAttribute("letter-spacing", "0.03em");
      label.setAttribute("pointer-events", "none");
      label.setAttribute("class", "arc-label");
      label.dataset.full = d.data.name;
      label.textContent = labelText;
      // Show only when the wedge is wide/tall enough to hold a few glyphs
      label.style.opacity = (arcLen > fontSize * 1.15 && bandW > 6) ? "1" : "0";
      gEl.appendChild(label);
    }

    allArcs.push({ data: d, el: path, label });
  }

  // Cluster labels (ring 1) — white with shadow for contrast on any arc color
  const clusters = root.descendants().filter((d) => d.depth === 1);

  for (const d of clusters) {
    const angle = (d.x0 + d.x1) / 2;
    const r = (d.y0 + d.y1) / 2;
    const arcSpan = d.x1 - d.x0;
    const bandW = d.y1 - d.y0;
    if (arcSpan < 0.12 || bandW < 16) continue;

    const text = document.createElementNS(SVG_NS, "text");
    const x = Math.sin(angle) * r;
    const y = -Math.cos(angle) * r;
    const deg = angle * 180 / Math.PI;
    const flip = deg > 90 && deg < 270;
    text.setAttribute("transform", "translate(" + x + "," + y + ") rotate(" + (flip ? deg + 180 : deg) + ")");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("fill", "#fff");
    text.setAttribute("paint-order", "stroke");
    text.setAttribute("stroke", "rgba(0,0,0,0.45)");
    text.setAttribute("stroke-width", "2px");
    text.setAttribute("stroke-linejoin", "round");
    text.setAttribute("font-size", "7px");
    text.setAttribute("font-family", "var(--mono)");
    text.setAttribute("letter-spacing", "0.08em");
    text.setAttribute("pointer-events", "none");
    text.setAttribute("class", "cluster-label");
    text.dataset.clusterName = d.data.cluster;
    text.textContent = d.data.name.toUpperCase();
    gEl.appendChild(text);
  }

  // Center label
  const center = $("center-label");
  center.querySelector(".center-title").textContent = "Tech Tank";
  center.querySelector(".center-sub").textContent = "click a segment to explore";
  center.classList.remove("has-detail");
  center.style.pointerEvents = "none";
  center.onclick = null;

  renderLegend();
}

function renderLegend() {
  const existing = document.querySelector(".legend");
  if (existing) existing.remove();
  const clusters = [...new Set(root.descendants().filter((d) => d.depth === 1).map((d) => d.data.cluster))];
  const legend = document.createElement("div");
  legend.className = "legend";
  for (const cl of clusters) {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = clusterColor(cl, 1);
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(titleCase(cl)));
    legend.appendChild(item);
  }
  $("sunburst").parentNode.insertBefore(legend, $("sunburst").nextSibling);
}

// ---- interactions ----
const tooltip = $("tooltip");

function onHover(event, d) {
  const isTool = !!d.data.tool;
  let html = `<div class="tt-name">${esc(d.data.name)}</div>`;
  if (isTool) {
    const t = d.data.tool;
    html += `<div class="tt-meta">${esc(t.category)} › ${esc(t.subcategory || "")}</div>`;
    html += `<div class="tt-stars">${stars(t)}</div>`;
  } else if (d.depth === 2) {
    html += `<div class="tt-meta">${d.children ? d.children.length : 0} tools</div>`;
  } else if (d.depth === 1) {
    html += `<div class="tt-meta">${d.children ? d.children.length : 0} categories · ${d.leaves().length} tools</div>`;
  }
  tooltip.innerHTML = html;
  tooltip.hidden = false;
}

function onMove(event) {
  tooltip.style.left = (event.clientX + 14) + "px";
  tooltip.style.top = (event.clientY - 10) + "px";
}

function onLeave() { tooltip.hidden = true; }

function onClickArc(d) {
  if (d.data.tool) { showDetail(d.data.tool); return; }
  zoomStack.push(currentZoom);
  zoomTo(d);
}

function zoomBack() {
  const prev = zoomStack.length ? zoomStack.pop() : root;
  zoomTo(prev);
}

// ---- zoom (animated arc paths) ----
function zoomTo(target) {
  // Save original positions before first zoom (for initial reference)
  root.each((d) => {
    if (d._ox0 === undefined) { d._ox0 = d.x0; d._ox1 = d.x1; d._oy0 = d.y0; d._oy1 = d.y1; }
  });

  // Save current positions as pre-zoom state for correct interpolation
  for (const { data: d } of allArcs) {
    d._pz0 = d.x0; d._pz1 = d.x1; d._py0 = d.y0; d._py1 = d.y1;
  }

  // Compute target positions.
  // NOTE: the radial maximum is the partition's outer radius, NOT root.y1.
  // d3.partition() places the root in only the *innermost* band
  // (root.y1 === radius / (root.height + 1)), so using root.y1 makes ySpan
  // negative for any non-root target and collapses every arc to zero area.
  const xSpan = target._ox1 - target._ox0 || 2 * Math.PI;
  const ySpan = radius - target._oy0 || 1;
  const xDomain = [target._ox0, target._ox0 + xSpan];
  const yDomain = [target._oy0, target._oy0 + ySpan];
  // Leave space for the center hole when zoomed, but ensure yMin < yMax.
  // The outer ring fills the full radius (yMax = radius).
  const centerMargin = target.depth ? Math.min(60, radius * 0.3) : 0;
  const yMin = centerMargin;
  const yMax = radius;

  const newX0 = [], newX1 = [], newY0 = [], newY1 = [];
  const nodes = [];
  for (const { data: d, el } of allArcs) {
    nodes.push(d);

    // Check if this arc is a descendant of the zoom target
    let isDescendant = false;
    let p = d.parent;
    while (p) {
      if (p === target) { isDescendant = true; break; }
      p = p.parent;
    }

    // Only descendants of the target should be visible when zoomed
    // Others are positioned outside the visible range
    if (isDescendant || d === target) {
      const tx0 = (d._ox0 - xDomain[0]) / xSpan * 2 * Math.PI;
      const tx1 = (d._ox1 - xDomain[0]) / xSpan * 2 * Math.PI;
      const ty0 = lerp(yMin, yMax, clamp((d._oy0 - yDomain[0]) / ySpan, 0, 1));
      const ty1 = lerp(yMin, yMax, clamp((d._oy1 - yDomain[0]) / ySpan, 0, 1));
      newX0.push(tx0); newX1.push(tx1); newY0.push(ty0); newY1.push(ty1);
    } else {
      // Position outside visible range
      newX0.push(-1); newX1.push(-1); newY0.push(0); newY1.push(0);
    }
  }

  // Animate from pre-zoom positions to target positions
  // Hide cluster labels during zoom animation
  const labels = gEl.querySelectorAll(".cluster-label");
  labels.forEach(lbl => lbl.style.opacity = "0");
  
  animate(450, (t, done) => {
    for (let i = 0; i < nodes.length; i++) {
      const d = nodes[i];
      const el = allArcs[i].el;
      const x0 = lerp(d._pz0, newX0[i], t);
      const x1 = lerp(d._pz1, newX1[i], t);
      const y0 = lerp(d._py0, newY0[i], t);
      const y1 = lerp(d._py1, newY1[i], t);
      const cl = d.data.cluster || d.parent?.data?.cluster || "other";
      const padAngle = d.depth === 3 ? 0.002 : 0.005;
      
      // Clamp positions for drawing, but use unclamped for visibility check
      const cx0 = Math.max(0, Math.min(2 * Math.PI, x0));
      const cx1 = Math.max(0, Math.min(2 * Math.PI, x1));
      el.setAttribute("d", arcPath(cx0, cx1, y0, y1, padAngle));
      
      // Hide arcs outside the visible range or with invalid geometry
      // Check if arc overlaps with [0, 2π] range and has positive dimensions
      const inRange = !(x1 < 0 || x0 > 2 * Math.PI); // arc overlaps [0, 2π]
      const hasSpan = x1 > x0 && y1 > 1;
      const visible = inRange && hasSpan;
      el.style.opacity = visible ? 1 : 0;

      // Track the arc's overview label with the animated geometry
      const label = allArcs[i].label;
      if (label) {
        const fs = d.depth === 3 ? 5 : 6;
        const midA = (x0 + x1) / 2;
        const midR = (y0 + y1) / 2;
        const lx = Math.sin(midA) * midR;
        const ly = -Math.cos(midA) * midR;
        const deg = midA * 180 / Math.PI;
        const flip = deg > 90 && deg < 270;
        label.setAttribute("x", lx);
        label.setAttribute("y", ly);
        label.setAttribute("transform", `rotate(${flip ? deg + 180 : deg} ${lx} ${ly})`);
        const arcLenNow = Math.abs(midR) * (x1 - x0);
        const bandNow = y1 - y0;
        const room = arcLenNow > fs * 1.15 && bandNow > 6;
        if (visible && room) {
          // Re-truncate against the current (possibly zoomed) wedge width
          const mc = Math.max(2, Math.floor(arcLenNow / (fs * 0.62)) - 1);
          let txt = label.dataset.full;
          if (txt.length > mc) txt = txt.slice(0, Math.max(1, mc - 1)) + "…";
          if (label.textContent !== txt) label.textContent = txt;
          label.style.opacity = "1";
        } else {
          label.style.opacity = "0";
        }
      }

      // Debug first 10 arcs on completion
      if (done && i < 10) {
        console.log(`Arc ${i} (${d.data.name}, depth ${d.depth}):`, {
          relDepth: d.depth - target.depth,
          x0, x1,
          y0, y1,
          _oy0: d._oy0, _oy1: d._oy1,
          yDomain, yMin, yMax, ySpan,
          visible
        });
      }
      
      // Update fill color based on relative depth from zoom target
      const relDepth = d.depth - target.depth;
      el.setAttribute("fill", clusterColor(cl, relDepth));
      if (done) { d.x0 = newX0[i]; d.x1 = newX1[i]; d.y0 = newY0[i]; d.y1 = newY1[i]; }
    }
    // Show labels again when animation done and at root level
    if (done && target === root) {
      labels.forEach(lbl => lbl.style.opacity = "1");
    }
  });

  // Update center label and back button
  const center = $("center-label");
  const backBtn = $("backBtn");
  if (target === root) {
    center.querySelector(".center-title").textContent = "Tech Tank";
    center.querySelector(".center-sub").textContent = "click a segment to explore";
    center.classList.remove("has-detail");
    center.onclick = null;
    backBtn.classList.remove("visible");
    zoomStack = [];
  } else {
    center.querySelector(".center-title").textContent = target.data.name;
    center.querySelector(".center-sub").textContent = "click center to zoom out";
    center.classList.add("has-detail");
    center.onclick = () => zoomBack();
    backBtn.classList.add("visible");
  }

  currentZoom = target;
}

// ---- search ----
function highlightSearch(query) {
  const q = (query || "").toLowerCase().trim();
  for (const { data: d, el } of allArcs) {
    el.classList.remove("dimmed", "highlighted");
    if (!q) continue;
    const name = (d.data.name || "").toLowerCase();
    const cluster = (d.data.cluster || "").toLowerCase();
    const t = d.data.tool;
    const toolName = t ? (t.name || "").toLowerCase() : "";
    const toolDesc = t ? (t.description || "").toLowerCase() : "";
    const toolCat = t ? (t.category || "").toLowerCase() : "";
    const toolSub = t ? (t.subcategory || "").toLowerCase() : "";
    const match = name.includes(q) || cluster.includes(q) || toolName.includes(q) || toolDesc.includes(q) || toolCat.includes(q) || toolSub.includes(q);
    el.classList.add(match ? "highlighted" : "dimmed");
  }
}

// ---- detail panel ----
function bar(label, display, pct) {
  return `<div class="bar-row"><span>${label}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.round(pct)}%"></span></span><b>${display}</b></div>`;
}
function kv(k, v) { return `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`; }
function norm(t) {
  const w = weight(t);
  const weights = TOOLS.map(weight);
  const wMin = Math.min(...weights), wMax = Math.max(...weights);
  return wMax > wMin ? Math.min(1, Math.max(0, (w - wMin) / (wMax - wMin))) : 0.5;
}
function isHot(t) {
  const sorted = TOOLS.map(num).sort((a, b) => a - b);
  return num(t) >= (sorted[Math.floor(sorted.length * 0.77)] ?? Infinity);
}

function detailHtml(t) {
  const subKey = `${t.category}|${t.subcategory}`;
  const subN = TOOLS.filter((x) => `${x.category}|${x.subcategory}` === subKey).length;
  const rank = t.rank_in_subcategory || "?";
  const hot = isHot(t) ? `<span class="d-hot">🔥 hot</span>` : "";
  const links = [];
  if (t.github_url) links.push(`<a class="d-link" href="${esc(t.github_url)}" target="_blank" rel="noopener"><span>↳</span><span class="grow">${esc(t.github_url.replace(/^https?:\/\/(www\.)?github\.com\//, ""))}</span><span>↗</span></a>`);
  if (t.link) links.push(`<a class="d-link" href="${esc(t.link)}" target="_blank" rel="noopener"><span>⊕</span><span class="grow">${esc(t.link.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</span><span>↗</span></a>`);

  return `
    <div class="d-head">
      <div>
        <h2>${esc(t.name)}</h2>
        <p class="d-rank">#${esc(rank)} of ${subN} in ${esc(t.subcategory || t.category)} ${hot}</p>
      </div>
      <div class="d-score"><b>${num(t) > 0 ? human(num(t)) : "—"}</b><span>github stars</span></div>
    </div>
    ${t.description ? `<p class="d-desc">${esc(t.description)}</p>` : ""}
    <div class="d-sec"><h4>Signal</h4>${bar("Stars", stars(t), norm(t) * 100)}</div>
    <div class="d-sec"><h4>Links</h4>${links.join("")}</div>
    <div class="d-sec"><h4>Properties</h4>
      ${kv("Offering", t.offering || "—")}
      ${kv("Open source", isTrue(t.open_source) ? "yes" : "no")}
      ${kv("Self-hostable", isTrue(t.self_hostable) ? "yes" : "no")}
      ${kv("Maturity", titleCase(t.maturity) || "—")}
      ${kv("Pricing", titleCase(t.pricing) || "—")}
      ${kv("Released", rel(t.released_at))}
    </div>
    <div class="d-sec"><h4>Ranking</h4>
      ${kv("Stars", num(t) > 0 ? human(num(t)) : "—")}
      ${kv("Rank", `#${rank} / ${subN}`)}
      ${kv("Subcategory", t.subcategory || "—")}
      ${kv("Category", t.category || "—")}
      ${kv("Cluster", titleCase(clusterOf(t.category)))}
    </div>`;
}

function showDetail(t) {
  $("detailBody").innerHTML = detailHtml(t);
  $("detailPanel").hidden = false;
}

function hideDetail() { $("detailPanel").hidden = true; }

// ---- boot ----
async function load() {
  try {
    const dataUrl = params().get("data") || DEFAULT_TOOLS;
    const catsUrl = params().get("cats") || DEFAULT_CATS;
    const [tools, cats] = await Promise.all([fetchCsv(dataUrl), fetchCsv(catsUrl).catch(() => [])]);
    CATS = cats;
    TOOLS = tools.filter((t) => t.name);
    $("count").textContent = `${TOOLS.length} tools`;
    renderSunburst(TOOLS);
  } catch (e) {
    $("sunburst").innerHTML = `<p class="error">Could not load data: ${esc(e.message)}.<br>Serve via <code>python3 -m http.server</code>.</p>`;
  }
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("theme", t);
  $("theme").textContent = t === "dark" ? "☀" : "🌙";
}

function wire() {
  applyTheme(localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("theme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  $("q").addEventListener("input", () => highlightSearch($("q").value));
  $("detailClose").onclick = hideDetail;
  $("backBtn").onclick = zoomBack;
  const observer = new MutationObserver(() => { if (TOOLS.length) renderSunburst(TOOLS); });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

(function start() {
  const ready = () => window.Papa && window.d3;
  if (ready()) { wire(); load(); }
  else { let n = 0; const iv = setInterval(() => { if (ready() || n++ > 50) { clearInterval(iv); wire(); load(); } }, 60); }
})();
