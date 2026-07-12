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
  if (depth === 1) return base;
  return base.replace(/oklch\(([\d.]+)/, (_, l) => `oklch(${Math.min(0.92, Number(l) + 0.08 * depth)})`);
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
  if (r1 <= 0 || x1 <= x0) return "";
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
function animate(duration, onFrame) {
  const start = performance.now();
  function tick(now) {
    const t = clamp((now - start) / duration, 0, 1);
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    onFrame(eased, t >= 1);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
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
  container.appendChild(svgEl);

  gEl = document.createElementNS(SVG_NS, "g");
  gEl.setAttribute("transform", `translate(${radius},${radius})`);
  svgEl.appendChild(gEl);

  // Build hierarchy with d3
  root = d3.hierarchy(data)
    .sum((d) => d.value || 0)
    .sort((a, b) => b.value - a.value);

  d3.partition().size([2 * Math.PI, radius])(root);

  currentZoom = root;
  allArcs = [];

  // Render arcs
  const descendants = root.descendants().filter((d) => d.depth > 0);
  for (const d of descendants) {
    const path = document.createElementNS(SVG_NS, "path");
    const cl = d.data.cluster || (d.depth === 1 ? d.data.cluster : d.parent?.data?.cluster) || "other";
    const padAngle = d.depth === 3 ? 0.002 : 0.005;
    path.setAttribute("d", arcPath(d.x0, d.x1, d.y0, d.y1, padAngle));
    path.setAttribute("fill", clusterColor(cl, d.depth));
    path.setAttribute("class", "sunburst-arc");
    path.setAttribute("data-cluster", cl);
    path.dataset.nodeId = d.data.name;

    path.addEventListener("mouseenter", (e) => onHover(e, d));
    path.addEventListener("mousemove", onMove);
    path.addEventListener("mouseleave", onLeave);
    path.addEventListener("click", () => onClickArc(d));

    gEl.appendChild(path);
    allArcs.push({ data: d, el: path });
  }

  // Cluster labels (ring 1)
  const clusters = root.descendants().filter((d) => d.depth === 1);
  const isDark = document.documentElement.dataset.theme === "dark";
  const labelColor = isDark ? "oklch(0.93 0.01 85)" : "oklch(0.20 0.01 60)";

  for (const d of clusters) {
    const angle = (d.x0 + d.x1) / 2;
    const r = (d.y0 + d.y1) / 2;
    const arcSpan = d.x1 - d.x0;
    const bandW = d.y1 - d.y0;
    if (arcSpan < 0.25 || bandW < 30) continue;

    const text = document.createElementNS(SVG_NS, "text");
    const x = Math.sin(angle) * r;
    const y = -Math.cos(angle) * r;
    const deg = angle * 180 / Math.PI;
    const flip = deg > 90 && deg < 270;
    text.setAttribute("transform", `translate(${x},${y}) rotate(${flip ? deg + 180 : deg})`);
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("fill", labelColor);
    text.setAttribute("font-size", "9px");
    text.setAttribute("font-family", "var(--mono)");
    text.setAttribute("letter-spacing", "0.08em");
    text.setAttribute("pointer-events", "none");
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
  zoomTo(d);
}

// ---- zoom (animated arc paths) ----
function zoomTo(target) {
  // Save original positions before zoom
  root.each((d) => {
    if (d._ox0 === undefined) { d._ox0 = d.x0; d._ox1 = d.x1; d._oy0 = d.y0; d._oy1 = d.y1; }
  });

  // Compute target positions
  const xDomain = [target._ox0, target._ox1];
  const yDomain = [target._oy0, root._oy1];
  const yMin = target.depth ? 60 : 0;
  const yMax = root._oy1 - (target.depth ? 60 : 0);

  const newX0 = [], newX1 = [], newY0 = [], newY1 = [];
  const paths = gEl.querySelectorAll("path");
  const nodes = [];
  for (const path of paths) {
    const d = allArcs.find((a) => a.el === path)?.data;
    if (!d) continue;
    nodes.push(d);

    // Map current (original) angles into target's [0, 2π] range
    const tx0 = clamp((d._ox0 - xDomain[0]) / (xDomain[1] - xDomain[0]) * 2 * Math.PI, 0, 2 * Math.PI);
    const tx1 = clamp((d._ox1 - xDomain[0]) / (xDomain[1] - xDomain[0]) * 2 * Math.PI, 0, 2 * Math.PI);
    const ty0 = lerp(yMin, yMax, (d._oy0 - yDomain[0]) / (yDomain[1] - yDomain[0]));
    const ty1 = lerp(yMin, yMax, (d._oy1 - yDomain[0]) / (yDomain[1] - yDomain[0]));
    newX0.push(tx0); newX1.push(tx1); newY0.push(ty0); newY1.push(ty1);
  }

  // Animate
  animate(450, (t, done) => {
    for (let i = 0; i < nodes.length; i++) {
      const d = nodes[i];
      const x0 = lerp(d.x0, newX0[i], t);
      const x1 = lerp(d.x1, newX1[i], t);
      const y0 = lerp(d.y0, newY0[i], t);
      const y1 = lerp(d.y1, newY1[i], t);
      const cl = d.data.cluster || d.parent?.data?.cluster || "other";
      const padAngle = d.depth === 3 ? 0.002 : 0.005;
      d.el.setAttribute("d", arcPath(x0, x1, y0, y1, padAngle));
      // Hide arcs outside the visible range
      const visible = x1 > 0 && x0 < 2 * Math.PI && y1 > y0;
      d.el.style.opacity = visible ? 1 : 0;
      if (done) { d.x0 = newX0[i]; d.x1 = newX1[i]; d.y0 = newY0[i]; d.y1 = newY1[i]; }
    }
  });

  // Update center label
  const center = $("center-label");
  if (target === root) {
    center.querySelector(".center-title").textContent = "Tech Tank";
    center.querySelector(".center-sub").textContent = "click a segment to explore";
    center.classList.remove("has-detail");
    center.style.pointerEvents = "none";
    center.onclick = null;
  } else {
    center.querySelector(".center-title").textContent = target.data.name;
    center.querySelector(".center-sub").textContent = target.depth === 1
      ? `${target.children?.length || 0} categories`
      : `${target.leaves().length} tools`;
    center.classList.add("has-detail");
    center.style.pointerEvents = "auto";
    center.onclick = () => zoomTo(root);
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
  const observer = new MutationObserver(() => { if (TOOLS.length) renderSunburst(TOOLS); });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

(function start() {
  const ready = () => window.Papa && window.d3;
  if (ready()) { wire(); load(); }
  else { let n = 0; const iv = setInterval(() => { if (ready() || n++ > 50) { clearInterval(iv); wire(); load(); } }, 60); }
})();
