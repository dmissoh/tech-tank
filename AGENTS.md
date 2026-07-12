# Agent Guide — Tech Tank

Ranked, filterable index of architecture/dev tooling. **No build step, no framework.** Static HTML + vanilla JS, data from CSV, deployed to Vercel.

## Quick Commands

```bash
# Local dev server (required — file:// won't load CSV due to CORS)
python3 -m http.server 8000

# Validate CSV schema (the only test)
node test.mjs

# Refresh data from Architools wiki (needs gh auth login for GitHub stars)
python3 extract_architools.py

# Deploy to Vercel production
vercel deploy --prod --yes

# Trigger GitHub Actions refresh + deploy
gh workflow run "Refresh data & deploy"
```

## Architecture

- **`index.html`** — single page, loads vendored d3-hierarchy + PapaParse via `<script defer>`, then `app.js`
- **`app.js`** — all app logic. Reads CSV at boot, renders treemap (Map view) or grouped cards (List view), deep-linked detail panel. No modules, no bundler.
- **`style.css`** — single stylesheet, uses `oklch()` colors with light/dark theme via `data-theme` attribute
- **`data/tool_landscape_live.csv`** — the primary data file. ~260 tools, 16 columns.
- **`data/tool_categories.csv`** — taxonomy: maps categories to clusters (27 rows).
- **`extract_architools.py`** — Python script that fetches the Architools wiki HTML, parses tool tables, fetches GitHub stars via `gh` CLI, writes the two CSVs.
- **`vendor/`** — vendored JS (d3-hierarchy, PapaParse) and fonts. Zero external requests.

## CSV Schema (the hard contract)

Both `node test.mjs` and `app.js` depend on exact column headers. If you add/remove/rename a column, update both the Python extractor AND the test.

`tool_landscape_live.csv`:
```
name,tool_id,category,subcategory,description,link,github_url,offering,
open_source,self_hostable,pricing,maturity,released_at,updated_at,score,rank_in_subcategory
```

`tool_categories.csv`:
```
category_id,subcategory_id,category,subcategory,description,cluster
```

## Key Gotchas

- **`score` = GitHub stargazer count**, not an editorial score. Log-scaled for treemap sizing; raw count shown in detail panel. Cross-category comparison is not valid (scores are weighted within categories).
- **`?data=URL.csv`** parameter lets users load external CSVs. The app also supports file upload via the "Load CSV…" button. If changing the default data path, check both `app.js` constants (`DEFAULT_TOOLS`, `DEFAULT_CATS`) and the `?data` param handling.
- **Treemap is capped at 160 tiles** (`MAP_CAP` in app.js). Narrow filters or use List view for all tools.
- **Cluster ordering** is hardcoded in `app.js` `renderList` (`order` array). New clusters need to be added there or they sort to the end.
- **Category→cluster mapping** lives in `extract_architools.py` `CLUSTER` dict. New categories must be added there too, or they land in "other".
- **Theme** persists to `localStorage("theme")`. The `<script>` in `<head>` sets `data-theme` before paint to avoid flash.

## Data Refresh Flow

`extract_architools.py` does three things in sequence:
1. Fetches/parses the Architools wiki HTML → extracts tool rows
2. Fetches GitHub stars for each tool with a `github_url` (via GitHub API, uses `gh auth token` or `GITHUB_TOKEN` env)
3. Ranks tools within each `(category, subcategory)` group

GitHub Actions runs this ~every 3 days, commits changed CSVs to `main`, then deploys to Vercel. The workflow needs `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` secrets.

## What NOT to Do

- Don't add a build step, bundler, or framework. The simplicity is intentional.
- Don't add npm/yarn/pnpm. Dependencies are vendored.
- Don't change CSV column headers without updating `test.mjs`, `extract_architools.py`, and `app.js`.
- Don't fetch external resources at runtime (the site must work offline/sub-path hosted).
- Don't use `file://` for local testing — use `python3 -m http.server`.
