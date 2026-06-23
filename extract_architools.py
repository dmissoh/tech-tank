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
            gh = link if "github.com" in link else ""
            website = "" if gh else link  # source has one URL per tool: repo OR site, not both
            oss = bool(gh)
            offering = "saas" if lang.lower() == "saas" else ("oss-library" if oss else "hybrid")
            tid = slug(tname)
            tools.append({
                "name": tname, "tool_id": tid, "category": name, "subcategory": lang or "General",
                "description": tdesc, "link": website, "github_url": gh, "offering": offering,
                "open_source": str(oss).lower(), "self_hostable": str(oss).lower(),
                "pricing": "free" if oss else "freemium", "maturity": "", "released_at": "", "updated_at": "",
                "score": 0, "rank_in_subcategory": 0,
            })
    return tools, cats

def rank(tools):
    groups = {}
    for t in tools:
        groups.setdefault((t["category"], t["subcategory"]), []).append(t)
    for arr in groups.values():
        for i, t in enumerate(sorted(arr, key=lambda x: -x["score"]), 1):
            t["rank_in_subcategory"] = i

def main():
    doc = open(sys.argv[1], encoding="utf-8").read() if len(sys.argv) > 1 else \
        urllib.request.urlopen(BASE).read().decode("utf-8")
    tools, cats = parse(doc)
    fetch_stars(tools)
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
