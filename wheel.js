// Tech Tank — Sunburst Wheel
// Interactive radial visualization of tools by cluster → category → tool.

const DEFAULT_TOOLS = "data/tool_landscape_live.csv";
const DEFAULT_CATS = "data/tool_categories.csv";

const $ = (id) => document.getElementById(id);
const params = () => new URLSearchParams(location.search);
const D3 = () => window.d3;

let TOOLS = [], CATS = [];
let allArcs = []; // flat list of {data, element} for search highlighting

// ---- helpers (duplicated from app.js to keep files independent) ----
const num = (t) => { const n = Number(t.score); return Number.isFinite(n) ? n : 0; };
const isTrue = (v) => String(v).toLowerCase() === "true";
const weight = (t) => Math.log10(num(t) + 1);
const human = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M"; if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k"; return String(n); };
const stars = (t) => (num(t) > 0 ? "★ " + human(num(t)) : "—");
const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const idOf = (t) => t.tool_id || (t.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
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
  "agent-layer":   { base: "oklch(0.62 0.16 30)",  light: "oklch(0.78 0.10 30)",  dark: "oklch(0.58 0.18 30)" },
  "runtime-stack": { base: "oklch(0.58 0.15 250)", light: "oklch(0.75 0.10 250)", dark: "oklch(0.54 0.17 250)" },
  "platform-infra":{ base: "oklch(0.62 0.13 160)", light: "oklch(0.78 0.08 160)", dark: "oklch(0.58 0.15 160)" },
  "modalities":    { base: "oklch(0.62 0.16 300)", light: "oklch(0.78 0.10 300)", dark: "oklch(0.58 0.18 300)" },
  "discovery":     { base: "oklch(0.68 0.14 85)",  light: "oklch(0.82 0.09 85)",  dark: "oklch(0.64 0.16 85)" },
  "domains":       { base: "oklch(0.58 0.11 140)", light: "oklch(0.74 0.08 140)", dark: "oklch(0.54 0.13 140)" },
  "other":         { base: "oklch(0.60 0.06 60)",  light: "oklch(0.76 0.04 60)",  dark: "oklch(0.56 0.08 60)" },
};

function clusterColor(cluster, depth) {
  const isDark = document.documentElement.dataset.theme === "dark";
  const pal = CLUSTER_COLORS[cluster] || CLUSTER_COLORS["other"];
  const base = isDark ? pal.dark : pal.light;
  if (depth === 1) return base; // cluster ring — full saturation
  // category / tool rings — slightly lighter
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
function buildHierarchy(tools, cats) {
  // root > cluster > category > tool
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

// ---- sunburst render ----
let svg, arc, partition, root;
const TRANSITION_MS = 450;

function renderSunburst(tools) {
  const d3 = D3();
  if (!d3) { $("sunburst").innerHTML = '<p class="error">d3-hierarchy failed to load.</p>'; return; }

  const data = buildHierarchy(tools, CATS);
  const w = Math.min(window.innerWidth - 820, window.innerHeight - 180, 700);
  const size = Math.max(420, Math.min(700, w));
  const radius = size / 2;

  $("sunburst").innerHTML = "";
  svg = d3.select("#sunburst")
    .append("svg")
    .attr("width", size)
    .attr("height", size)
    .append("g")
    .attr("transform", `translate(${radius},${radius})`);

  partition = d3.partition().size([2 * Math.PI, radius]);
  root = d3.hierarchy(data)
    .sum((d) => d.value || 0)
    .sort((a, b) => b.value - a.value);

  partition(root);

  arc = d3.arc()
    .startAngle((d) => d.x0)
    .endAngle((d) => d.x1)
    .padAngle(0.005)
    .padRadius(radius / 2)
    .innerRadius((d) => d.y0)
    .outerRadius((d) => d.y1 - 1);

  // Store current angles for transitions
  root.each((d) => { d.x0s = d.x0; d.x1s = d.x1; d.y0s = d.y0; d.y1s = d.y1; });

  allArcs = [];

  const paths = svg.selectAll("path")
    .data(root.descendants().filter((d) => d.depth > 0))
    .join("path")
    .attr("class", "sunburst-arc")
    .attr("d", arc)
    .attr("fill", (d) => {
      const cluster = d.data.cluster || (d.depth === 1 ? d.data.cluster : d.parent?.data?.cluster) || "other";
      if (d.depth === 1) return clusterColor(cluster, 1);
      if (d.depth === 2) return clusterColor(cluster, 2);
      return clusterColor(cluster, 3);
    })
    .attr("data-cluster", (d) => d.data.cluster || "")
    .attr("data-name", (d) => d.data.name || "")
    .on("mouseenter", onHover)
    .on("mousemove", onMove)
    .on("mouseleave", onLeave)
    .on("click", onClick);

  paths.each(function(d) { allArcs.push({ data: d, el: this }); });

  // cluster labels (ring 1 only)
  svg.selectAll("text.cluster-label")
    .data(root.descendants().filter((d) => d.depth === 1))
    .join("text")
    .attr("class", "cluster-label")
    .attr("transform", (d) => {
      const angle = (d.x0 + d.x1) / 2;
      const r = (d.y0 + d.y1) / 2;
      const x = Math.sin(angle) * r;
      const y = -Math.cos(angle) * r;
      const deg = (angle * 180 / Math.PI);
      const flip = deg > 90 && deg < 270;
      return `translate(${x},${y}) rotate(${flip ? deg + 180 : deg})`;
    })
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "central")
    .attr("fill", (d) => {
      const isDark = document.documentElement.dataset.theme === "dark";
      return isDark ? "oklch(0.93 0.01 85)" : "oklch(0.20 0.01 60)";
    })
    .attr("font-size", "9px")
    .attr("font-family", "var(--mono)")
    .attr("letter-spacing", "0.08em")
    .attr("pointer-events", "none")
    .attr("text-transform", "uppercase")
    .text((d) => {
      const angle = d.x1 - d.x0;
      const r = d.y1 - d.y0;
      // Only show label if arc is big enough
      if (angle < 0.25 || r < 30) return "";
      return d.data.name.toUpperCase();
    });

  // legend
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
  const isCategory = d.depth === 2;
  const isCluster = d.depth === 1;

  let html = `<div class="tt-name">${esc(d.data.name)}</div>`;
  if (isTool) {
    const t = d.data.tool;
    html += `<div class="tt-meta">${esc(t.category)} › ${esc(t.subcategory || "")}</div>`;
    html += `<div class="tt-stars">${stars(t)}</div>`;
  } else if (isCategory) {
    const count = d.children ? d.children.length : 0;
    html += `<div class="tt-meta">${count} tool${count !== 1 ? "s" : ""}</div>`;
  } else if (isCluster) {
    const cats = d.children ? d.children.length : 0;
    const tools = d.leaves().length;
    html += `<div class="tt-meta">${cats} categories · ${tools} tools</div>`;
  }
  tooltip.innerHTML = html;
  tooltip.hidden = false;
}

function onMove(event) {
  tooltip.style.left = (event.clientX + 14) + "px";
  tooltip.style.top = (event.clientY - 10) + "px";
}

function onLeave() { tooltip.hidden = true; }

function onClick(event, d) {
  const isTool = !!d.data.tool;
  const isCategory = d.depth === 2;
  const isCluster = d.depth === 1;

  if (isTool) {
    showDetail(d.data.tool);
    return;
  }

  // Zoom into category or cluster
  zoomTo(d);
}

function zoomTo(target) {
  const d3 = D3();
  const t = svg.transition().duration(TRANSITION_MS);

  const xScale = d3.scaleLinear().domain([target.x0, target.x1]).range([0, 2 * Math.PI]);
  const yScale = d3.scaleLinear().domain([target.y0, root.y1]).range([target.depth ? 60 : 0, root.y1 - (target.depth ? 60 : 0)]);

  svg.selectAll("path")
    .transition(t)
    .attrTween("d", function(d) {
      const xi = d3.interpolate(d.x0, Math.max(0, Math.min(2 * Math.PI, xScale(d.x0))));
      const xf = d3.interpolate(d.x1, Math.max(0, Math.min(2 * Math.PI, xScale(d.x1))));
      const yi = d3.interpolate(d.y0, yScale(d.y0));
      const yf = d3.interpolate(d.y1, yScale(d.y1));
      return function(s) {
        d.x0 = xi(s); d.x1 = xf(s);
        d.y0 = yi(s); d.y1 = yf(s);
        return arc(d);
      };
    })
    .attr("fill-opacity", (d) => {
      const angle = xScale(d.x0) < 0 || xScale(d.x1) > 2 * Math.PI ? 0 : 1;
      return angle;
    });

  svg.selectAll("text.cluster-label")
    .transition(t)
    .attr("opacity", (d) => {
      const angle = xScale(d.x0) < 0 || xScale(d.x1) > 2 * Math.PI ? 0 : 1;
      return angle;
    });

  // Update center label
  const center = $("center-label");
  if (target.depth === 0) {
    center.querySelector(".center-title").textContent = "Tech Tank";
    center.querySelector(".center-sub").textContent = "click a segment to explore";
    center.classList.remove("has-detail");
  } else {
    center.querySelector(".center-title").textContent = target.data.name;
    center.querySelector(".center-sub").textContent = target.depth === 1
      ? `${target.children?.length || 0} categories`
      : `${target.leaves().length} tools`;
    center.classList.add("has-detail");
  }

  // Make center clickable to zoom out
  center.style.pointerEvents = target.depth > 0 ? "auto" : "none";
  center.onclick = () => zoomTo(root);
}

function resetZoom() {
  zoomTo(root);
}

// ---- search ----
function highlightSearch(query) {
  const q = (query || "").toLowerCase().trim();
  for (const { data: d, el } of allArcs) {
    el.classList.remove("dimmed", "highlighted");
    if (!q) continue;
    const name = (d.data.name || "").toLowerCase();
    const cluster = (d.data.cluster || "").toLowerCase();
    const toolName = d.data.tool ? (d.data.tool.name || "").toLowerCase() : "";
    const toolDesc = d.data.tool ? (d.data.tool.description || "").toLowerCase() : "";
    const toolCat = d.data.tool ? (d.data.tool.category || "").toLowerCase() : "";
    const toolSub = d.data.tool ? (d.data.tool.subcategory || "").toLowerCase() : "";

    const matches = name.includes(q) || cluster.includes(q) || toolName.includes(q) || toolDesc.includes(q) || toolCat.includes(q) || toolSub.includes(q);
    if (matches) {
      el.classList.add("highlighted");
    } else {
      el.classList.add("dimmed");
    }
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
function isHot(t, tools) {
  const sorted = tools.map(num).sort((a, b) => a - b);
  const cut = sorted[Math.floor(sorted.length * 0.77)] ?? Infinity;
  return num(t) >= cut;
}

function detailHtml(t) {
  const subKey = `${t.category}|${t.subcategory}`;
  const subN = TOOLS.filter((x) => `${x.category}|${x.subcategory}` === subKey).length;
  const rank = t.rank_in_subcategory || "?";
  const hot = isHot(t, TOOLS) ? `<span class="d-hot">🔥 hot</span>` : "";
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
    <div class="d-sec">
      <h4>Signal</h4>
      ${bar("Stars", stars(t), norm(t) * 100)}
    </div>
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

function hideDetail() {
  $("detailPanel").hidden = true;
}

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
  // Re-render on theme change to update colors
  const observer = new MutationObserver(() => { if (TOOLS.length) renderSunburst(TOOLS); });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

(function start() {
  const ready = () => window.Papa && window.d3;
  if (ready()) { wire(); load(); }
  else { let n = 0; const iv = setInterval(() => { if (ready() || n++ > 50) { clearInterval(iv); wire(); load(); } }, 60); }
})();
