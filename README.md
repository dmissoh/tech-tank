# Tech Tank

A ranked, filterable index of architecture and dev tooling. Design is a static replica of
[devindex.ai](https://devindex.ai); the data is extracted from the
[Architools tooling wiki](https://yawo.github.io/architools/tooling/tools.html).
No build step, no framework.

Two views (toggle in the header, deep-linked via `?view=`):

- **Map** — a nested squarified treemap (categories → tool tiles sized by score, heat-colored).
- **List** — cards grouped by cluster → category → subcategory.

Click any tile/card to open a deep-linked detail panel (`?tool=<id>`): breadcrumb, score,
rank in subcategory, signal bar, links, and a properties/ranking metrics grid. `Esc` closes it.

Light/dark theme toggle (🌙/☀) in the header; respects your OS preference and persists.

A **Just Landed** panel sits to the right of the treemap (stacks below on narrow screens) and
lists the newest tools — toggle **released** (repo creation date) vs **updated** (last push).
**See all** opens the flat, ungrouped list sorted by that date (`?view=list&sort=…&group=off`).
Dates come from GitHub; tools without a repo are omitted.

The List view has **Sort** (stars / name / released / updated) and a **Group** toggle; both are
reflected in the URL so any list state is shareable.

Treemap layout uses `d3-hierarchy` (CDN); CSV parsing uses PapaParse (CDN). No install.

## Run

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

(Opening `index.html` via `file://` will not load the CSV due to browser CORS; use a static server.)

## Providing your own tools (external CSV)

Three ways, in order of laziness:

1. **Upload** — click **Load CSV…** and pick a local file. Nothing else needed.
2. **URL** — append a query param: `?data=https://example.com/my_tools.csv`
   (optional `&cats=https://example.com/my_categories.csv`).
3. **Replace the file** — overwrite `data/tool_landscape_live.csv`.

### CSV schema

`tool_landscape_live.csv` columns (header row is the contract):

```text
name,tool_id,category,subcategory,description,link,github_url,offering,
open_source,self_hostable,pricing,maturity,released_at,updated_at,score,rank_in_subcategory
```

- `open_source`, `self_hostable`: `true`/`false`
- `score`: number (weighted **within** a category — cross-category comparison is not valid)
- `category` is grouped into a `cluster` via `data/tool_categories.csv`. That file is
  optional: tools without a matching category land in an `other` cluster.

`tool_categories.csv` (optional taxonomy) columns:

```text
category_id,subcategory_id,category,subcategory,description,cluster
```

## Refreshing the Architools data

The bundled `data/*.csv` are generated from the Architools wiki by `extract_architools.py`:

```bash
python3 extract_architools.py            # fetch live wiki, rewrite data/*.csv
python3 extract_architools.py page.html  # or parse a local HTML copy
```

Mapping notes: `language → subcategory`; `open_source`/`self_hostable` = has a GitHub link;
`offering`/`pricing` derived from that. **`score` = real GitHub stargazer count**, fetched via
the `gh` CLI token (needs `gh auth login`); tools without a public repo get 0. Stars span
orders of magnitude, so the treemap sizing and heat coloring are log-scaled while the detail
panel shows the raw count.

## Test

```bash
node test.mjs   # validates CSV headers
```

## Deploy

The site is fully self-contained: fonts (`vendor/fonts.css` + woff2), `d3-hierarchy`, and
PapaParse are vendored under `vendor/`, so it makes **zero external requests** and runs on any
static host. All paths are relative, so it also works from a sub-path.

### Live

Hosted on **Vercel** (project `v2`): <https://v2-six-hazel.vercel.app>

One-off manual deploy from this folder (needs `vercel login` once):

```bash
vercel deploy --prod --yes
```

### Automated refresh and deploy (GitHub Actions)

`.github/workflows/refresh.yml` keeps the live site current.

- **Schedule:** about every 3 days (`cron: 0 6 */3 * *`, 06:00 UTC).
- **Manual:** `workflow_dispatch`, so you can trigger it on demand.

Each run:

1. Runs `extract_architools.py` to rebuild `data/*.csv` from the Architools wiki (GitHub stars
   fetched with the built-in `GITHUB_TOKEN`, no extra secret needed).
2. Validates the CSV schema (`node test.mjs`).
3. Commits the refreshed data back to `main` (only when it changed).
4. Deploys to Vercel production.

#### Required repository secrets

| Secret | What it is | Where to get it |
| --- | --- | --- |
| `VERCEL_TOKEN` | Vercel access token | Vercel dashboard, Account Settings then Tokens |
| `VERCEL_ORG_ID` | Vercel team/org id | `.vercel/project.json` (`orgId`) |
| `VERCEL_PROJECT_ID` | Vercel project id | `.vercel/project.json` (`projectId`) |

```bash
gh secret set VERCEL_TOKEN --repo <you>/tech-tank          # prompts for the value
gh secret set VERCEL_ORG_ID --repo <you>/tech-tank --body "team_…"
gh secret set VERCEL_PROJECT_ID --repo <you>/tech-tank --body "prj_…"
```

#### Trigger a run manually

```bash
gh workflow run "Refresh data & deploy" --repo <you>/tech-tank
gh run watch --repo <you>/tech-tank
```

Or use the GitHub Actions tab: "Refresh data & deploy" then "Run workflow".
