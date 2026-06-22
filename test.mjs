// Smoke test: the app's only hard contract is the CSV headers ("schemas live in
// the column headers"). If a data refresh drops/renames a column, fail loudly.
// Run: node test.mjs
import { readFileSync } from "node:fs";

const firstLine = (p) => readFileSync(new URL(p, import.meta.url), "utf8").split(/\r?\n/)[0];

const TOOLS_COLS = ["name","tool_id","category","subcategory","description","link","github_url",
  "offering","open_source","self_hostable","pricing","maturity","released_at","updated_at","score","rank_in_subcategory"];
const CATS_COLS = ["category_id","subcategory_id","category","subcategory","description","cluster"];

function check(file, expected) {
  const got = firstLine(file).split(",");
  for (const col of expected)
    if (!got.includes(col)) throw new Error(`${file}: missing column "${col}" (got: ${got.join(",")})`);
  console.log(`ok ${file} — ${got.length} columns`);
}

check("data/tool_landscape_live.csv", TOOLS_COLS);
check("data/tool_categories.csv", CATS_COLS);
console.log("all schema checks passed");
