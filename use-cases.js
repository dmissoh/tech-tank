/* ============================================================
   use-cases.js — Use Cases page logic
   ============================================================ */

(function () {
  "use strict";

  /* ---- constants ---- */
  const FILES = { en: "all_en.csv", fr: "all_fr.csv" };
  const I18N = {
    en: {
      eyebrow: "AI use cases across industries",
      "hero-title": 'Real-world AI <em>use cases.</em>',
      "hero-lede": "Explore how companies deploy AI and discover opportunities for your industry.",
      "search-placeholder": "Search use cases, companies...",
      "all-categories": "All categories",
      "all-subcategories": "All subcategories",
      "all-types": "All types",
      "type-company": "Company Use Cases",
      "type-opportunity": "Opportunities",
      loading: "Loading use cases...",
      "no-results": "No use cases match your filters.",
      "footer-text": "Use cases extracted from industry reports and AI deployment documentation.",
      categories: "categories",
      "use-cases": "use cases",
      companies: "companies",
      expand: "Read more",
      collapse: "Show less",
      "total-use-cases": "Total use cases",
      industries: "Industries",
      companies_count: "Companies",
      "type-label-company": "Company",
      "type-label-opportunity": "Opportunity",
    },
    fr: {
      eyebrow: "Cas d'utilisation de l'IA par secteur",
      "hero-title": 'Cas d\'utilisation <em>IA concrets.</em>',
      "hero-lede": "Explorez comment les entreprises deployent l'IA et découvrez des opportunités pour votre secteur.",
      "search-placeholder": "Rechercher des cas d'utilisation, entreprises...",
      "all-categories": "Toutes les catégories",
      "all-subcategories": "Toutes les sous-catégories",
      "all-types": "Tous les types",
      "type-company": "Cas d'entreprise",
      "type-opportunity": "Opportunités",
      loading: "Chargement des cas d'utilisation...",
      "no-results": "Aucun cas d'utilisation ne correspond à vos filtres.",
      "footer-text": "Cas d'utilisation extraits de rapports sectoriels et de documentations de déploiement d'IA.",
      categories: "catégories",
      "use-cases": "cas d'utilisation",
      companies: "entreprises",
      expand: "Lire la suite",
      collapse: "Réduire",
      "total-use-cases": "Total des cas d'utilisation",
      industries: "Secteurs",
      companies_count: "Entreprises",
      "type-label-company": "Entreprise",
      "type-label-opportunity": "Opportunité",
    },
  };

  /* ---- state ---- */
  let lang = localStorage.getItem("uc-lang") || "en";
  let allData = [];
  let filtered = [];
  let acIndex = [];
  let acActive = -1;

  /* ---- DOM refs ---- */
  const $ = (s) => document.querySelector(s);
  const $q = $("#q");
  const $ac = $("#autocomplete");
  const $cat = $("#category");
  const $sub = $("#subcategory");
  const $type = $("#type");
  const $count = $("#count");
  const $grid = $("#grid");
  const $status = $("#status");
  const $empty = $("#empty");
  const $stats = $("#stats");
  const $langBtn = $("#langToggle");

  /* ---- i18n ---- */
  function t(key) { return (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key; }

  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const val = t(key);
      if (val) el.innerHTML = val;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
    });
    document.querySelectorAll("select option[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      const val = t(key);
      if (val) el.textContent = val;
    });
    $langBtn.textContent = lang === "en" ? "EN" : "FR";
    document.documentElement.lang = lang;
  }

  /* ---- CSV parsing ---- */
  function parseLine(line) {
    // Format: Category,Type,Subcategory,"\\usecase{Title}{Category}{Sub}{Desc}"
    if (!line || line.length < 5) return null;
    // Find the macro part
    const macroMatch = line.match(/\\(companyusecase|opportunityusecase)\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}\{([\s\S]*)\}/);
    if (!macroMatch) return null;

    const type = macroMatch[1];
    const title = macroMatch[2].trim();
    const category = macroMatch[3].trim();
    const subcategory = macroMatch[4].trim();
    const description = macroMatch[5].replace(/}$/, "").trim();

    // Get the leading category from CSV column 1
    const csvSubcategory = line.split(",")[2].trim();
    const csvCategory = line.split(",")[0].trim();

    return {
      csvSubcategory,
      type,
      title,
      category: category || csvCategory,
      csvCategory,
      subcategory,
      description,
    };
  }

  function parseCSV(text) {
    const lines = text.split("\n");
    const data = [];
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseLine(lines[i]);
      if (parsed) data.push(parsed);
    }
    return data;
  }

  /* ---- data loading ---- */
  async function loadData() {
    $status.hidden = false;
    $grid.hidden = true;
    $empty.hidden = true;
    $status.textContent = t("loading");

    try {
      const resp = await fetch(FILES[lang]);
      if (!resp.ok) throw new Error(resp.status);
      const text = await resp.text();
      allData = parseCSV(text);
      buildACIndex();
      populateFilters();
      applyFilters();
      renderStats();
    } catch (e) {
      $status.textContent = "Error loading data: " + e.message;
      $status.classList.add("error");
    }
  }

  /* ---- autocomplete index ---- */
  function buildACIndex() {
    acIndex = allData.map((d, i) => ({
      i,
      text: (d.title + " " + d.description).toLowerCase(),
      title: d.title,
      category: d.category,
      type: d.type,
    }));
  }

  /* ---- filters ---- */
  function populateFilters() {
    // Categories
    const cats = [...new Set(allData.map((d) => d.csvCategory || d.category))].sort();
    $cat.innerHTML = '<option value="">' + t("all-categories") + "</option>";
    cats.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      $cat.appendChild(opt);
    });

    // Subcategories
    const subs = [...new Set(allData.map((d) => d.csvSubcategory || d.subcategory).filter(Boolean))].sort();
    $sub.innerHTML = '<option value="">' + t("all-subcategories") + "</option>";
    subs.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      $sub.appendChild(opt);
    });

    // Type (already in HTML)
  }

  function applyFilters() {
    const q = $q.value.toLowerCase().trim();
    const cat = $cat.value;
    const sub = $sub.value;
    const typ = $type.value;

    filtered = allData.filter((d) => {
      if (cat && (d.csvCategory || d.category) !== cat) return false;
      if (sub && (d.csvSubcategory || d.subcategory) !== sub) return false;
      if (typ && d.type !== typ) return false;
      if (q) {
        const hay = (d.title + " " + d.description + " " + d.category + " " + (d.csvSubcategory || d.subcategory)).toLowerCase();
        return hay.includes(q);
      }
      return true;
    });

    renderCards();
    $count.textContent = filtered.length + " / " + allData.length;
  }

  /* ---- stats ---- */
  function renderStats() {
    const cats = new Set(allData.map((d) => d.csvCategory || d.category));
    const cos = new Set(allData.map((d) => d.title));
    $stats.innerHTML =
      '<div class="stat"><b>' + allData.length + "</b><span>" + t("total-use-cases") + "</span></div>" +
      '<div class="stat"><b>' + cats.size + "</b><span>" + t("industries") + "</span></div>" +
      '<div class="stat"><b>' + cos.size + "</b><span>" + t("companies_count") + "</span></div>";
  }

  /* ---- render cards ---- */
  function renderCards() {
    $status.hidden = true;
    if (filtered.length === 0) {
      $grid.hidden = true;
      $empty.hidden = false;
      return;
    }
    $empty.hidden = true;
    $grid.hidden = false;

    // Limit rendering for performance
    const toRender = filtered.slice(0, 300);
    const frag = document.createDocumentFragment();

    toRender.forEach((d, idx) => {
      const card = document.createElement("div");
      card.className = "card";
      card.style.animationDelay = Math.min(idx * 0.02, 0.6) + "s";

      const isOpp = d.type === "opportunityusecase";
      const typeLabel = isOpp ? t("type-label-opportunity") : t("type-label-company");
      const pillClass = isOpp ? "pill-opportunity" : "pill-company";

      const needsExpand = d.description.length > 200;

      card.innerHTML =
        '<div class="card-head">' +
          '<h3 class="card-title">' + escHtml(d.title) + "</h3>" +
          '<div class="card-pills">' +
            '<span class="pill ' + pillClass + '">' + escHtml(typeLabel) + "</span>" +
          "</div>" +
        "</div>" +
        '<p class="card-desc">' + escHtml(d.description) + "</p>" +
        (needsExpand
          ? '<button class="card-expand">' + t("expand") + "</button>"
          : "") +
        '<div class="card-footer">' +
          '<span class="card-category">' + escHtml(d.csvCategory || d.category) + "</span>" +
          (d.subcategory
            ? '<span class="card-subcategory">' + escHtml(d.subcategory) + "</span>"
            : "") +
        "</div>";

      // Expand/collapse
      if (needsExpand) {
        const btn = card.querySelector(".card-expand");
        btn.addEventListener("click", () => {
          const expanded = card.classList.toggle("expanded");
          btn.textContent = expanded ? t("collapse") : t("expand");
        });
      }

      frag.appendChild(card);
    });

    $grid.innerHTML = "";
    $grid.appendChild(frag);

    if (filtered.length > 300) {
      const more = document.createElement("p");
      more.className = "loading";
      more.textContent = "... and " + (filtered.length - 300) + " more";
      $grid.appendChild(more);
    }
  }

  function escHtml(s) {
    const d = document.createElement("div");
    d.textContent = s;
    return d.innerHTML;
  }

  /* ---- autocomplete ---- */
  function showAC(query) {
    if (!query || query.length < 2) {
      $ac.hidden = true;
      return;
    }
    const q = query.toLowerCase();
    const hits = acIndex
      .filter((e) => e.text.includes(q))
      .slice(0, 8);

    if (hits.length === 0) {
      $ac.hidden = true;
      return;
    }

    acActive = -1;
    $ac.innerHTML = "";
    hits.forEach((h, idx) => {
      const div = document.createElement("div");
      div.className = "ac-item";
      div.dataset.idx = h.i;
      div.innerHTML =
        '<div class="ac-title">' + highlightMatch(h.title, q) + "</div>" +
        '<div class="ac-meta">' + escHtml(h.category) + " &middot; " + escHtml(h.type === "companyusecase" ? "Company" : "Opportunity") + "</div>";
      div.addEventListener("mousedown", (e) => {
        e.preventDefault();
        $q.value = h.title;
        $ac.hidden = true;
        applyFilters();
      });
      $ac.appendChild(div);
    });
    $ac.hidden = false;
  }

  function highlightMatch(text, query) {
    const idx = text.toLowerCase().indexOf(query);
    if (idx === -1) return escHtml(text);
    return (
      escHtml(text.slice(0, idx)) +
      '<span class="ac-highlight">' + escHtml(text.slice(idx, idx + query.length)) + "</span>" +
      escHtml(text.slice(idx + query.length))
    );
  }

  function acNavigate(dir) {
    const items = $ac.querySelectorAll(".ac-item");
    if (!items.length) return;
    items.forEach((el) => el.classList.remove("active"));
    acActive += dir;
    if (acActive < 0) acActive = items.length - 1;
    if (acActive >= items.length) acActive = 0;
    items[acActive].classList.add("active");
    items[acActive].scrollIntoView({ block: "nearest" });
  }

  function acSelect() {
    const items = $ac.querySelectorAll(".ac-item");
    if (acActive >= 0 && acActive < items.length) {
      $q.value = items[acActive].querySelector(".ac-title").textContent;
      $ac.hidden = true;
      applyFilters();
    }
  }

  /* ---- theme ---- */
  function initTheme() {
    const btn = $("#theme");
    function updateBtn() {
      btn.textContent = document.documentElement.dataset.theme === "dark" ? "\u2600" : "\uD83C\uDF19";
    }
    updateBtn();
    btn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("theme", next);
      updateBtn();
    });
  }

  /* ---- events ---- */
  function wireEvents() {
    // Filters
    $cat.addEventListener("change", applyFilters);
    $sub.addEventListener("change", applyFilters);
    $type.addEventListener("change", applyFilters);

    // Search
    let debounce;
    $q.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        showAC($q.value.trim());
        applyFilters();
      }, 150);
    });

    // Autocomplete keyboard
    $q.addEventListener("keydown", (e) => {
      if ($ac.hidden) return;
      if (e.key === "ArrowDown") { e.preventDefault(); acNavigate(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); acNavigate(-1); }
      else if (e.key === "Enter" && acActive >= 0) { e.preventDefault(); acSelect(); }
      else if (e.key === "Escape") { $ac.hidden = true; }
    });

    // Close autocomplete on outside click
    document.addEventListener("click", (e) => {
      if (!$ac.contains(e.target) && e.target !== $q) $ac.hidden = true;
    });

    // Language toggle
    $langBtn.addEventListener("click", () => {
      lang = lang === "en" ? "fr" : "en";
      localStorage.setItem("uc-lang", lang);
      applyI18n();
      populateFilters();
      $q.value = "";
      $cat.value = "";
      $sub.value = "";
      $type.value = "";
      loadData();
    });

    // Theme
    initTheme();
  }

  /* ---- init ---- */
  function init() {
    applyI18n();
    wireEvents();
    loadData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
