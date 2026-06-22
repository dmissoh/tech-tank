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

```
name,tool_id,category,subcategory,description,link,github_url,offering,
open_source,self_hostable,pricing,maturity,released_at,score,rank_in_subcategory
```

- `open_source`, `self_hostable`: `true`/`false`
- `score`: number (weighted **within** a category — cross-category comparison is not valid)
- `category` is grouped into a `cluster` via `data/tool_categories.csv`. That file is
  optional: tools without a matching category land in an `other` cluster.

`tool_categories.csv` (optional taxonomy) columns:

```
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

Fully self-contained — fonts (`vendor/fonts.css` + woff2), `d3-hierarchy`, and PapaParse are
vendored under `vendor/`, so the page makes **zero external requests**. Drop the folder on any
static host (GitHub Pages, Vercel, Netlify, Cloudflare Pages, S3). All paths are relative, so it
works at a sub-path (e.g. `user.github.io/tech-tank/`).

### GitHub Pages

`.nojekyll` is included so Jekyll won't touch `vendor/`. Create the repo, push `main`, enable Pages:

```bash
gh repo create tech-tank --public --source=. --remote=origin --push
gh api -X POST repos/<you>/tech-tank/pages -f 'source[branch]=main' -f 'source[path]=/'
# → https://<you>.github.io/tech-tank/
```
