#!/usr/bin/env python3
"""Extract the Architools tooling wiki into the Dev Index CSV schema.

Source: https://yawo.github.io/architools/tooling/tools.html  (Name | Description | Language tables)
Usage:  python3 extract_architools.py            # fetch live + write data/*.csv
        python3 extract_architools.py file.html   # parse a local copy instead

`score` = real GitHub stargazer count (fetched via the `gh` CLI token). Tools
without a GitHub repo get score 0. Re-run anytime to refresh stars.
"""
import csv, html, json, os, re, subprocess, sys, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin

BASE = "https://yawo.github.io/architools/tooling/tools.html"

# architools category -> cluster (the app groups list view by cluster)
CLUSTER = {
    "Agent Runtimes & Frameworks": "agent-layer",
    "AI Coding Assistants & Harnesses": "agent-layer",
    "Memory & Context Management": "agent-layer",
    "Model Context Protocol (MCP)": "agent-layer",
    "Databases & Vector Stores": "runtime-stack",
    "RAG & Knowledge Graphs": "runtime-stack",
    "LLM APIs & Routing": "runtime-stack",
    "Infrastructure & Eventing": "runtime-stack",
    "Developer Tools & CLI": "platform-infra",
    "Developer Utilities": "platform-infra",
    "Diagramming & Architecture": "platform-infra",
    "Security, Privacy & Pentesting": "platform-infra",
    "Web & App Frameworks": "platform-infra",
    "Web Scraping & Automation": "platform-infra",
    "Productivity & Workflow": "platform-infra",
    "Data & OSINT": "platform-infra",
    "Data & Open Data": "platform-infra",
    "Agent Skills": "agent-layer",
    "Computer Vision": "modalities",
    "Git & Version Control": "platform-infra",
    "LLM Inference & Compute": "runtime-stack",
    "Time Series & Tabular Models": "domains",
    "Voice & Audio AI": "modalities",
    "Video & Media Generation": "modalities",
    "UI/UX & Design Tools": "modalities",
    "Academic & Research": "discovery",
    "LLM Training & Education": "discovery",
    "Obsidian Ecosystem": "discovery",
    "Finance & Trading": "domains",
    "Legal & Compliance": "domains",
    "French Admin & Finance Skills": "domains",
}

def slug(s):
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", s.lower()))

def gh_token():
    env = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")  # CI provides this
    if env:
        return env
    try:
        return subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return None

def repo_path(github_url):  # owner/repo from a github URL (first two path segments)
    m = re.search(r"github\.com/([^/]+)/([^/#?]+)", github_url)
    return f"{m.group(1)}/{m.group(2).removesuffix('.git')}" if m else None

def resolve_wiki_links(tools):
    """For tools whose link points to the architools wiki instead of a real repo,
    scrape the individual wiki page to extract the actual GitHub URL."""
    wiki_tools = [t for t in tools if not t["github_url"] and "yawo.github.io/architools" in t["link"]]
    if not wiki_tools:
        return
    print(f"resolving {len(wiki_tools)} wiki-only links via individual pages...", file=sys.stderr)

    def fetch_one(t):
        try:
            page = urllib.request.urlopen(t["link"], timeout=15).read().decode("utf-8", errors="ignore")
            gh_links = re.findall(r'href="([^"]*github\.com/[^/]+/[^"#?]+)', page)
            real = [l for l in gh_links if "yawo/architools" not in l]
            if real:
                t["github_url"] = real[0]
                t["link"] = real[0]  # point to the real repo, not the wiki page
        except Exception as e:
            print(f"  {t['name']}: {e}", file=sys.stderr)

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(fetch_one, wiki_tools))
    resolved = sum(1 for t in wiki_tools if t["github_url"])
    print(f"resolved {resolved}/{len(wiki_tools)} wiki links to real GitHub repos", file=sys.stderr)

    # Also fix tools that already had github_url but link still points to wiki
    fixed = 0
    for t in tools:
        if t["github_url"] and "yawo.github.io/architools" in t["link"]:
            t["link"] = t["github_url"]
            fixed += 1
    if fixed:
        print(f"fixed {fixed} tools where github_url existed but link was still wiki", file=sys.stderr)

def fetch_stars(tools):
    token = gh_token()
    if not token:
        print("WARN: no gh token — stars unavailable, scores left at 0", file=sys.stderr)
        return
    hdr = {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "User-Agent": "devindex"}

    def one(t):
        path = repo_path(t["github_url"])
        if not path:
            return
        try:
            req = urllib.request.Request(f"https://api.github.com/repos/{path}", headers=hdr)
            d = json.load(urllib.request.urlopen(req, timeout=20))
            t["score"] = d.get("stargazers_count", 0)
            t["released_at"] = (d.get("created_at") or "")[:10]  # repo creation ≈ released
            t["updated_at"] = (d.get("pushed_at") or "")[:10]    # last push ≈ updated
        except urllib.error.HTTPError as e:
            print(f"  {path}: HTTP {e.code}", file=sys.stderr)  # moved/renamed/private -> stays 0
        except Exception as e:
            print(f"  {path}: {e}", file=sys.stderr)

    gh = [t for t in tools if t["github_url"]]
    with ThreadPoolExecutor(max_workers=10) as pool:
        list(pool.map(one, gh))
    print(f"fetched stars for {sum(1 for t in gh if t['score'])}/{len(gh)} github repos")

def clean(s):
    text = html.unescape(re.sub(r"<[^>]+>", "", s))
    return re.sub(r"[​‌‍﻿]", "", text).strip()

def make_tool(category, tname, link, tdesc, lang):
    """Convert one (name, link, description, language) row into a tool dict."""
    link = urljoin(BASE, html.unescape(link)) if link else ""
    gh = link if "github.com" in link else ""
    website = "" if gh else link  # source has one URL per tool: repo OR site, not both
    oss = bool(gh)
    offering = "saas" if lang.lower() == "saas" else ("oss-library" if oss else "hybrid")
    return {
        "name": tname, "tool_id": slug(tname), "category": category, "subcategory": lang or "General",
        "description": tdesc, "link": website, "github_url": gh, "offering": offering,
        "open_source": str(oss).lower(), "self_hostable": str(oss).lower(),
        "pricing": "free" if oss else "freemium", "maturity": "", "released_at": "", "updated_at": "",
        "score": 0, "rank_in_subcategory": 0,
    }

def parse_pipe_table(sec):
    """Parse markdown pipe-table tool rows the wiki renders as <p>| link | desc | lang |</p>."""
    entries = []
    for pm in re.finditer(r"<p>(\s*\|.*?)</p>", sec, re.S):
        txt = pm.group(1)
        if "<a href" not in txt:
            continue
        cells = [c.strip() for c in txt.split("|")]
        cells = cells[1:-1]  # drop leading/trailing empties from the outer pipes
        i = 0
        while i < len(cells):
            if i + 2 >= len(cells):
                break
            nm_cell, desc_cell, lang_cell = cells[i], cells[i + 1], cells[i + 2]
            link_m = re.search(r'href="([^"]+)"', nm_cell)
            tname = clean(nm_cell)
            if tname:
                entries.append((tname, link_m.group(1) if link_m else "", clean(desc_cell), lang_cell.strip()))
            i += 3
            if i < len(cells) and cells[i] == "":
                i += 1  # separator cell between rows
    return entries

def parse(doc):
    # split into <h2 id=...>Name ...</h2> ... (until next <h2 or end)
    secs = re.split(r'<h2 id="[^"]*"[^>]*>', doc)
    tools, cats = [], []
    for sec in secs[1:]:
        name = clean(sec.split("</h2>", 1)[0])
        if name not in CLUSTER:
            continue  # skip non-tool headings (Categories, etc.)
        desc_m = re.search(r"</h2>\s*<p>(.*?)</p>", sec, re.S)
        cat_desc = clean(desc_m.group(1)) if desc_m else ""
        cats.append((slug(name), name, cat_desc, CLUSTER[name]))
        body = sec.split("<tbody>", 1)[1].split("</tbody>", 1)[0] if "<tbody>" in sec else ""
        for row in re.findall(r"<tr>(.*?)</tr>", body, re.S):
            tds = re.findall(r"<td>(.*?)</td>", row, re.S)
            if len(tds) < 3:
                continue
            link_m = re.search(r'href="([^"]+)"', tds[0])
            link = urljoin(BASE, html.unescape(link_m.group(1))) if link_m else ""
            tname, tdesc, lang = clean(tds[0]), clean(tds[1]), clean(tds[2])
            if not tname:
                continue
            tools.append(make_tool(name, tname, link, tdesc, lang))
        # second format: markdown pipe-tables rendered as <p> after the <hr>
        for tname, link, tdesc, lang in parse_pipe_table(sec):
            tools.append(make_tool(name, tname, link, tdesc, lang))
    return tools, cats

def rank(tools):
    groups = {}
    for t in tools:
        groups.setdefault((t["category"], t["subcategory"]), []).append(t)
    for arr in groups.values():
        for i, t in enumerate(sorted(arr, key=lambda x: -int(x["score"] or 0)), 1):
            t["rank_in_subcategory"] = i

def fix_categorization(tools):
    """Post-processing to fix categorization issues found in the source data."""

    # 1. Move skill-related tools from "Agent Runtimes & Frameworks" to "Agent Skills"
    # These are curated lists, skill collections, or skill frameworks
    for t in tools:
        if t["category"] == "Agent Runtimes & Frameworks":
            desc_lower = t["description"].lower()
            name_lower = t["name"].lower()
            # Check if it's a skill-related tool:
            # - Name contains "skill" or "skills" (e.g., "google/skills")
            # - Description mentions skills and is a collection/list
            is_skill_name = any(kw in name_lower for kw in ["skill", "skills", "awesome"])
            is_skill_desc = ("skill" in desc_lower and
                           ("collection" in desc_lower or "curated" in desc_lower or
                            "library" in desc_lower or "list" in desc_lower or
                            "framework" in desc_lower))
            # Don't move tools that are clearly runtimes/frameworks (not skill collections)
            # Note: "skills framework" is still a skill tool, not a runtime
            is_runtime = any(kw in desc_lower for kw in ["runtime", "harness", "orchestrator"]) and "skill" not in desc_lower
            if (is_skill_name or is_skill_desc) and not is_runtime:
                t["category"] = "Agent Skills"
    
    # 2. Move MCP tools from "Memory & Context Management" to "Model Context Protocol (MCP)"
    # These are MCP servers that provide memory functionality
    for t in tools:
        if t["category"] == "Memory & Context Management":
            desc_lower = t["description"].lower()
            name_lower = t["name"].lower()
            # Check if it's an MCP server (name contains mcp or description mentions MCP server)
            if ("mcp" in name_lower or "mcp server" in desc_lower or 
                "model context protocol" in desc_lower):
                t["category"] = "Model Context Protocol (MCP)"
    
    # 3. Fix invalid subcategories
    # Replace invalid subcategories with "Various"
    invalid_subcats = {"--", "1.1k", "N/A", "n/a", ""}
    for t in tools:
        if t["subcategory"] in invalid_subcats:
            t["subcategory"] = "Various"
    
    # 4. Remove duplicate tools (keep the one in the more specific category)
    # Build a map of tool_id -> list of tools
    tool_map = {}
    for t in tools:
        tid = t["tool_id"]
        if tid not in tool_map:
            tool_map[tid] = []
        tool_map[tid].append(t)
    
    # For duplicates, keep the one in the more specific category
    seen = set()
    unique_tools = []
    for t in tools:
        tid = t["tool_id"]
        if tid in seen:
            continue
        if len(tool_map[tid]) > 1:
            # Keep the first occurrence (should be in the more specific category)
            seen.add(tid)
        unique_tools.append(t)
    
    return unique_tools

def main():
    doc = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else \
        urllib.request.urlopen(BASE).read().decode("utf-8")
    tools, cats = parse(doc)
    resolve_wiki_links(tools)
    fetch_stars(tools)
    tools = fix_categorization(tools)
    rank(tools)
    cols = ["name","tool_id","category","subcategory","description","link","github_url","offering",
            "open_source","self_hostable","pricing","maturity","released_at","updated_at","score","rank_in_subcategory"]
    with open("data/tool_landscape_live.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(tools)
    with open("data/tool_categories.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["category_id","subcategory_id","category","subcategory","description","cluster"])
        for cid, name, desc, cluster in cats:
            w.writerow([cid, "", name, "", desc, cluster])
    print(f"wrote {len(tools)} tools across {len(cats)} categories")

if __name__ == "__main__":
    main()
