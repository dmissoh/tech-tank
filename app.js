// Dev Index — static replica. Reads CSV (built-in, ?data=URL, or upload) and renders
// a treemap "map" view + grouped "list" view, with a deep-linked detail panel.

const DEFAULT_TOOLS = "data/tool_landscape_live.csv";
const DEFAULT_CATS = "data/tool_categories.csv";
const SOURCE_URL = "https://yawo.github.io/architools/tooling/tools.html"; // "view in source wiki"
const MAP_CAP = 160; // tiles shown in map view (keeps them legible, mirrors "trending")

const $ = (id) => document.getElementById(id);
const params = () => new URLSearchParams(location.search);
const D3 = () => window.d3;

let TOOLS = [], CATS = [];
let SUBSIZE = new Map();      // "category|subcategory" -> count (stable ranks)
let HOT_CUT = Infinity, WMIN = 0, WMAX = 1; // weight = log10(score+1): stars span orders of magnitude
let VIEW = "map";
let LANDED_MODE = "released", LANDED_N = 12;
let SORT = "score", GROUP = true;

const SORTERS = {
  score: (a, b) => num(b) - num(a),
  name: (a, b) => (a.name || "").localeCompare(b.name || ""),
  released: (a, b) => (b.released_at || "").localeCompare(a.released_at || ""), // empty last
  updated: (a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""),
};
const sortTools = (arr, key) => [...arr].sort(SORTERS[key] || SORTERS.score);

const titleCase = (s) => (s || "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const num = (t) => { const n = Number(t.score); return Number.isFinite(n) ? n : 0; };
const isTrue = (v) => String(v).toLowerCase() === "true";
const weight = (t) => Math.log10(num(t) + 1);            // size/heat on a log scale
const norm = (t) => (WMAX > WMIN ? Math.min(1, Math.max(0, (weight(t) - WMIN) / (WMAX - WMIN))) : 0.5);
const human = (n) => { n = Number(n) || 0; if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M"; if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "") + "k"; return String(n); };
const stars = (t) => (num(t) > 0 ? "★ " + human(num(t)) : "—"); // score IS github stars
const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const idOf = (t) => t.tool_id || (t.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

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

// ---- CSV ----
const parseCsv = (text) => Papa.parse(text.trim(), { header: true, skipEmptyLines: true }).data;
async function fetchCsv(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return parseCsv(await r.text());
}

// ---- taxonomy ----
const catRow = (cat) => CATS.find((c) => c.category === cat && !c.subcategory_id);
const clusterOf = (cat) => (catRow(cat) || {}).cluster || "other";
const catDesc = (cat) => (catRow(cat) || {}).description || "";

// ---- derived state ----
function recompute() {
  const w = TOOLS.map(weight);
  WMIN = Math.min(...w); WMAX = Math.max(...w);
  const sorted = TOOLS.map(num).sort((a, b) => a - b);
  HOT_CUT = sorted[Math.floor(sorted.length * 0.77)] ?? Infinity; // ~top 23% = "hot"
  SUBSIZE = new Map();
  for (const t of TOOLS) {
    const k = `${t.category}|${t.subcategory}`;
    SUBSIZE.set(k, (SUBSIZE.get(k) || 0) + 1);
  }
}
const isHot = (t) => num(t) >= HOT_CUT;

// ---- filtering ----
function filters() {
  return {
    q: $("q").value.trim().toLowerCase(), cluster: $("cluster").value, category: $("category").value,
    maturity: $("maturity").value, pricing: $("pricing").value, offering: $("offering").value,
    oss: $("oss").checked, selfhost: $("selfhost").checked,
  };
}
function applyFilters(f) {
  return TOOLS.filter((t) => {
    if (f.cluster && clusterOf(t.category) !== f.cluster) return false;
    if (f.category && t.category !== f.category) return false;
    if (f.maturity && t.maturity !== f.maturity) return false;
    if (f.pricing && t.pricing !== f.pricing) return false;
    if (f.offering && t.offering !== f.offering) return false;
    if (f.oss && !isTrue(t.open_source)) return false;
    if (f.selfhost && !isTrue(t.self_hostable)) return false;
    if (f.q && !`${t.name} ${t.description} ${t.subcategory} ${t.category}`.toLowerCase().includes(f.q)) return false;
    return true;
  });
}

// ---- dom helper ----
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

// ---- MAP VIEW (treemap) ----
function renderMap(tools, root) {
  const d3 = D3();
  if (!d3) { root.appendChild(el("p", "error", "Treemap library failed to load (d3-hierarchy). Switch to List view.")); return; }

  const shown = [...tools].sort((a, b) => num(b) - num(a)).slice(0, MAP_CAP);
  if (tools.length > shown.length)
    root.appendChild(el("p", "tm-note", `Map shows top ${shown.length} of ${tools.length} by score — narrow filters, or use List for all.`));

  // hierarchy: root > category > tool(leaf=score)
  const byCat = new Map();
  for (const t of shown) { if (!byCat.has(t.category)) byCat.set(t.category, []); byCat.get(t.category).push(t); }
  const data = { children: [...byCat].map(([cat, items]) => ({ cat, children: items.map((t) => ({ t, value: Math.max(weight(t), 0.04) })) })) };

  const wrapEl = el("div", "treemap");
  root.appendChild(wrapEl);
  const W = wrapEl.clientWidth || 1100;
  const H = Math.max(640, Math.min(1500, 280 + shown.length * 4.5));
  wrapEl.style.height = H + "px";

  const hroot = d3.hierarchy(data).sum((d) => d.value || 0).sort((a, b) => b.value - a.value);
  d3.treemap().tile(d3.treemapSquarify.ratio(1.4)).size([W, H]).paddingOuter(4).paddingTop(22).paddingInner(3).round(true)(hroot);

  for (const cat of hroot.children || []) {
    const box = el("div", "tm-cat");
    Object.assign(box.style, { left: cat.x0 + "px", top: cat.y0 + "px", width: cat.x1 - cat.x0 + "px", height: cat.y1 - cat.y0 + "px" });
    box.appendChild(el("div", "tm-head", `<span>${esc(cat.data.cat)}</span><span class="n">${cat.children.length}</span>`));
    wrapEl.appendChild(box);

    for (const leaf of cat.children) {
      const t = leaf.data.t, w = leaf.x1 - leaf.x0, h = leaf.y1 - leaf.y0;
      const tile = el("div", "tile");
      tile.style.setProperty("--t", norm(t).toFixed(3));
      Object.assign(tile.style, { left: leaf.x0 + "px", top: leaf.y0 + "px", width: w + "px", height: h + "px" });
      if (h < 46 || w < 86) tile.classList.add("sm");
      if (h < 30 || w < 56) tile.classList.add("xs");
      const flame = isHot(t) ? "🔥 " : "";
      let inner = `<span class="nm">${esc(t.name)}</span><span class="sc">${flame}${stars(t)}</span>`;
      inner += `<span class="sub">${esc(t.subcategory || t.category)}</span>`;
      if (h > 16 && w > 26) tile.innerHTML = inner;
      tile.title = `${t.name} · ${stars(t)} · ${t.subcategory}`;
      tile.onclick = () => openDetail(idOf(t));
      wrapEl.appendChild(tile);
    }
  }
}

// ---- LIST VIEW ----
function group(tools) {
  const m = new Map(); // cluster -> cat -> sub -> []
  for (const t of tools) {
    const cl = clusterOf(t.category);
    if (!m.has(cl)) m.set(cl, new Map());
    const c = m.get(cl); if (!c.has(t.category)) c.set(t.category, new Map());
    const s = c.get(t.category); const sub = t.subcategory || "—";
    if (!s.has(sub)) s.set(sub, []); s.get(sub).push(t);
  }
  for (const c of m.values()) for (const s of c.values()) for (const arr of s.values()) arr.sort((a, b) => num(b) - num(a));
  return m;
}
function card(t) {
  const c = el("div", "card");
  c.style.setProperty("--t", norm(t).toFixed(3));
  const flame = isHot(t) ? '<span class="flame">🔥</span>' : "";
  const tags = [];
  if (isTrue(t.open_source)) tags.push('<span class="pill oss">OSS</span>');
  if (t.offering) tags.push(`<span class="pill">${esc(t.offering)}</span>`);
  if (t.pricing) tags.push(`<span class="pill">${esc(t.pricing)}</span>`);
  if (t.maturity) tags.push(`<span class="pill">${esc(t.maturity)}</span>`);
  const dateField = SORT === "updated" ? "updated_at" : SORT === "released" ? "released_at" : null;
  const when = dateField && t[dateField] ? `<div class="when">${SORT === "updated" ? "updated" : "released"} ${rel(t[dateField])}</div>` : "";
  c.innerHTML = `<div class="top"><span class="nm">${esc(t.name)}</span><span class="sc">${flame} ${stars(t)}</span></div>` +
    (t.description ? `<p class="desc">${esc(t.description)}</p>` : "") + when +
    `<div class="tags">${tags.join("")}</div>`;
  c.onclick = () => openDetail(idOf(t));
  return c;
}
function renderList(tools, root) {
  // flat (group off): one sorted grid, devindex /tools/?group=off style
  if (!GROUP) {
    root.appendChild(el("p", "list-head", `${tools.length} tools · sorted by ${SORT === "score" ? "stars" : SORT}`));
    const g = el("div", "grid");
    for (const t of sortTools(tools, SORT)) g.appendChild(card(t));
    root.appendChild(g);
    return;
  }
  const grouped = group(tools);
  const order = ["agent-layer", "runtime-stack", "platform-infra", "modalities", "discovery"];
  const clusters = [...grouped.keys()].sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || a.localeCompare(b));
  for (const cl of clusters) {
    root.appendChild(el("h2", "cluster-head", esc(titleCase(cl))));
    const byCat = grouped.get(cl);
    for (const cat of [...byCat.keys()].sort()) {
      const block = el("section", "cat");
      block.appendChild(el("h2", null, esc(cat)));
      if (catDesc(cat)) block.appendChild(el("p", "cat-desc", esc(catDesc(cat))));
      const bySub = byCat.get(cat);
      for (const sub of [...bySub.keys()].sort()) {
        const sb = el("div", "subcat");
        if (sub && sub !== "—") sb.appendChild(el("h3", null, esc(sub)));
        const g = el("div", "grid");
        for (const t of sortTools(bySub.get(sub), SORT)) g.appendChild(card(t));
        sb.appendChild(g);
        block.appendChild(sb);
      }
      root.appendChild(block);
    }
  }
}

// ---- JUST LANDED (right sidebar in map view) ----
function renderLanded() {
  const field = LANDED_MODE === "updated" ? "updated_at" : "released_at";
  const dated = sortTools(TOOLS.filter((t) => t[field]), LANDED_MODE);
  $("landed").hidden = VIEW !== "map" || !dated.length;
  const list = $("landedList"); list.innerHTML = "";
  for (const t of dated.slice(0, LANDED_N)) {
    const row = el("div", "landed-row");
    const crumb = t.category + (t.subcategory && t.subcategory !== "General" ? " · " + t.subcategory : "");
    row.innerHTML = `<div class="info"><div class="crumb-sm">${esc(crumb)}</div><div class="nm">${esc(t.name)}</div></div><div class="when">${rel(t[field])}</div>`;
    row.onclick = () => openDetail(idOf(t));
    list.appendChild(row);
  }
  $("landedMore").textContent = `see all ${dated.length} →`;
}
function setLanded(m) {
  LANDED_MODE = m;
  $("lRel").setAttribute("aria-pressed", String(m === "released"));
  $("lUpd").setAttribute("aria-pressed", String(m === "updated"));
  renderLanded();
}
// "see all" → flat list sorted by the current landed mode (devindex /tools/?sort=…&group=off)
function goToReleases() {
  $("sort").value = LANDED_MODE;
  $("group").checked = false;
  SORT = LANDED_MODE; GROUP = false;
  setView("list");
  scrollTo({ top: 0, behavior: "smooth" });
}

// ---- render orchestration ----
function render() {
  const f = filters();
  const tools = applyFilters(f);
  $("count").textContent = `${tools.length} of ${TOOLS.length} tools`;
  // toggle the sidebar BEFORE rendering the map, so the treemap measures the correct width
  const field = LANDED_MODE === "updated" ? "updated_at" : "released_at";
  $("landed").hidden = VIEW !== "map" || !TOOLS.some((t) => t[field]);
  const root = $("view"); root.innerHTML = "";
  if (!tools.length) { root.appendChild(el("p", "empty", "No tools match these filters.")); }
  else (VIEW === "map" ? renderMap : renderList)(tools, root);
  renderLanded();
}

// ---- DETAIL PANEL ----
function bar(label, display, pct) {
  return `<div class="bar-row"><span>${label}</span><span class="bar-track"><span class="bar-fill" style="width:${Math.round(pct)}%"></span></span><b>${display}</b></div>`;
}
function kv(k, v) { return `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`; }

function detailHtml(t) {
  const subKey = `${t.category}|${t.subcategory}`, subN = SUBSIZE.get(subKey) || 1;
  const rank = t.rank_in_subcategory || "?";
  const hot = isHot(t) ? `<span class="d-hot">🔥 hot</span>` : "";
  const links = [];
  if (t.github_url) links.push(`<a class="d-link" href="${esc(t.github_url)}" target="_blank" rel="noopener"><span>↳</span><span class="grow">${esc(t.github_url.replace(/^https?:\/\/(www\.)?github\.com\//, ""))}</span><span>↗</span></a>`);
  if (t.link) links.push(`<a class="d-link" href="${esc(t.link)}" target="_blank" rel="noopener"><span>⊕</span><span class="grow">${esc(t.link.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))}</span><span>↗</span></a>`);
  links.push(`<a class="d-link" href="${SOURCE_URL}" target="_blank" rel="noopener"><span>✎</span><span class="grow">View in source wiki</span><span>ARCHITOOLS ↗</span></a>`);

  return `
    <div class="d-head">
      <div>
        <h2 id="dTitle">${esc(t.name)}</h2>
        <p class="d-rank">#${esc(rank)} of ${subN} in ${esc(t.subcategory || t.category)} ${hot}</p>
      </div>
      <div class="d-score"><b>${num(t) > 0 ? human(num(t)) : "—"}</b><span>github stars</span></div>
    </div>
    ${t.description ? `<p class="d-desc">${esc(t.description)}</p>` : ""}
    <div class="d-cols">
      <div class="d-sec">
        <h4>Signal</h4>
        ${bar("Stars", stars(t), norm(t) * 100)}
        <p class="mono" style="margin-top:14px;color:var(--faint)">Score = GitHub stargazers (log-scaled for sizing). A popularity signal, not an endorsement.</p>
      </div>
      <div class="d-sec"><h4>Links</h4>${links.join("")}</div>
    </div>
    <div class="metrics">
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
      </div>
    </div>
    <p class="d-foot">tool_id: ${esc(idOf(t))}</p>`;
}

function showDetail(t) {
  $("dCrumb").innerHTML = `<a href="?">All</a> › <a href="?cluster=${encodeURIComponent(clusterOf(t.category))}">${esc(titleCase(clusterOf(t.category)))}</a> › ${esc(t.category)} › ${esc(t.subcategory || "")}`;
  $("dBody").innerHTML = detailHtml(t);
  $("overlay").hidden = false;
  document.body.style.overflow = "hidden";
}
function hideDetail() { $("overlay").hidden = true; document.body.style.overflow = ""; }

function openDetail(id) {
  const t = TOOLS.find((x) => idOf(x) === id);
  if (!t) return;
  const p = params(); p.set("tool", id);
  history.pushState({ tool: id }, "", "?" + p.toString());
  showDetail(t);
}
function closeDetail() {
  if (params().get("tool")) history.back(); else hideDetail();
}

// ---- view toggle ----
function setView(v, push = true) {
  VIEW = v === "list" ? "list" : "map";
  $("vMap").setAttribute("aria-pressed", String(VIEW === "map"));
  $("vList").setAttribute("aria-pressed", String(VIEW === "list"));
  document.querySelectorAll(".list-only").forEach((e) => (e.hidden = VIEW !== "list"));
  if (push) {
    const p = params();
    p.set("view", VIEW);
    if (VIEW === "list") { p.set("sort", SORT); p.set("group", GROUP ? "on" : "off"); }
    else { p.delete("sort"); p.delete("group"); }
    history.replaceState(history.state, "", "?" + p.toString());
  }
  render();
}

// ---- stats + filter options ----
function fillStats() {
  const cats = new Set(TOOLS.map((t) => t.category)).size;
  const hot = TOOLS.filter(isHot).length;
  const oss = TOOLS.filter((t) => isTrue(t.open_source)).length;
  const pct = TOOLS.length ? Math.round((oss / TOOLS.length) * 100) : 0;
  const items = [[TOOLS.length, "tools in index"], [cats, "categories covered"], [hot, "hot right now"], [pct + "%", "open source"]];
  $("stats").innerHTML = items.map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("");
}
function fillOptions() {
  const uniq = (k) => [...new Set(TOOLS.map((t) => t[k]).filter(Boolean))].sort();
  const set = (id, vals, label) => { const s = $(id); s.length = 1; for (const v of vals) s.add(new Option(label ? label(v) : v, v)); };
  set("cluster", [...new Set(TOOLS.map((t) => clusterOf(t.category)))].sort(), titleCase);
  set("category", uniq("category"));
  set("maturity", uniq("maturity"), titleCase);
  set("pricing", uniq("pricing"), titleCase);
  set("offering", uniq("offering"), titleCase);
}

// ---- boot ----
function ingest(tools) { TOOLS = tools.filter((t) => t.name); recompute(); fillStats(); fillOptions(); }

async function load(toolsUrl, catsUrl) {
  try {
    const [tools, cats] = await Promise.all([fetchCsv(toolsUrl), catsUrl ? fetchCsv(catsUrl).catch(() => []) : Promise.resolve([])]);
    CATS = cats; ingest(tools);
    syncFromUrl();
  } catch (e) {
    $("view").innerHTML = `<p class="error">Could not load data: ${esc(e.message)}.<br>Serve via <code>python3 -m http.server</code>, or use <strong>Load CSV…</strong>.</p>`;
  }
}

function syncFromUrl() {
  const p = params();
  if (p.get("sort") && SORTERS[p.get("sort")]) { SORT = p.get("sort"); $("sort").value = SORT; }
  if (p.get("group")) { GROUP = p.get("group") !== "off"; $("group").checked = GROUP; }
  setView(p.get("view") || "map", false);
  const tool = p.get("tool");
  if (tool) { const t = TOOLS.find((x) => idOf(x) === tool); t ? showDetail(t) : hideDetail(); } else hideDetail();
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("theme", t);
  $("theme").textContent = t === "dark" ? "☀" : "🌙";
}

function wire() {
  applyTheme(localStorage.getItem("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  $("theme").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  ["q", "cluster", "category", "maturity", "pricing", "offering", "oss", "selfhost"].forEach((id) => $(id).addEventListener("input", render));
  $("vMap").onclick = () => setView("map");
  $("vList").onclick = () => setView("list");
  $("lRel").onclick = () => setLanded("released");
  $("lUpd").onclick = () => setLanded("updated");
  $("landedMore").onclick = goToReleases;
  $("sort").onchange = () => { SORT = $("sort").value; setView("list"); };
  $("group").onchange = () => { GROUP = $("group").checked; setView("list"); };
  $("dClose").onclick = closeDetail;
  $("overlay").onclick = (e) => { if (e.target === $("overlay")) closeDetail(); };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("overlay").hidden) closeDetail(); });
  window.addEventListener("popstate", () => { const t = params().get("tool"); if (t) { const x = TOOLS.find((y) => idOf(y) === t); x ? showDetail(x) : hideDetail(); } else hideDetail(); });
  window.addEventListener("resize", () => { if (VIEW === "map") render(); });

  $("csvFile").addEventListener("change", (ev) => {
    const file = ev.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = () => { ingest(parseCsv(r.result)); render(); };
    r.readAsText(file);
  });

  const p = params();
  const dataUrl = p.get("data"), catsUrl = p.get("cats") || DEFAULT_CATS;
  if (dataUrl) { const a = $("sourceLink"); a.hidden = false; a.href = dataUrl; }
  load(dataUrl || DEFAULT_TOOLS, catsUrl);
}

(function start() {
  const ready = () => window.Papa && window.d3;
  if (ready()) wire();
  else { let n = 0; const iv = setInterval(() => { if (ready() || n++ > 50) { clearInterval(iv); wire(); } }, 60); }
})();
