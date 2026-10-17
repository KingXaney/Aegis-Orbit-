# Aegis Orbit LLM Wiki: schema

This folder is an LLM-maintained knowledge base built on Andrej Karpathy's
[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern. A RAG setup
re-reads raw documents on every question. Here the agent compiles sources once into a persistent,
interlinked set of markdown pages and keeps those pages current as new sources arrive.

- **The human** curates sources, asks questions and decides what matters.
- **The agent** (you) writes and maintains every page in `wiki/`: summaries, cross-references,
  contradictions, the index and the log.
- **This file** is the contract between the two. The human and the agent revise it together when a
  convention stops working, and record each change in `wiki/log.md` as a `schema` entry.

## Domain

Aegis Orbit is the orbital collision-avoidance simulator in this repository (`../`). The wiki also
covers the astrodynamics and conjunction-assessment knowledge needed to understand, change or question
the simulator: propagation, screening, collision probability, maneuver planning, and the LLM agent that
explains the results.

## Layers

| Layer | Path | Owner | Rule |
|---|---|---|---|
| Raw sources | `raw/` | human | Immutable. Read them; never edit, rename or delete them. Images go in `raw/assets/`. |
| Codebase | `../` (repo root) | developers | A source read at a pinned commit. Wiki workflows never edit code. |
| Wiki | `wiki/` | agent | The agent writes everything here; the human reads it. |
| Schema | `CLAUDE.md` (this file) | both | Co-evolved. Log every change. |

```
doc/
├── CLAUDE.md          schema (this file)
├── README.md          human entry point and usage
├── raw/               immutable sources (+ assets/ for images)
└── wiki/
    ├── index.md       catalog of every page; read it first on every query
    ├── log.md         append-only chronology of ingests, queries, lints, schema changes
    ├── overview.md    top-level synthesis; the first page a human should read
    ├── sources/       one summary page per ingested source
    ├── concepts/      domain ideas (TCA, Pc, frames …), explained independently of the code
    ├── components/    parts of the codebase: responsibility, mechanics, code locations, gotchas
    ├── scenarios/     the simulator's scenarios as entities: setup, behaviour, numbers
    └── analyses/      answers worth keeping: measured runs, comparisons, open questions
```

## Page conventions

**Names.** kebab-case `.md`. Analyses are dated, `YYYY-MM-DD-slug.md`, except standing pages such as
`open-questions.md`. Source pages are `codebase-<short-sha>.md` for code, `<author>-<year>-<slug>.md`
for papers and `<site>-<slug>.md` for web articles.

**Frontmatter** is required and Dataview-friendly:

```yaml
---
title: Collision probability (Pc)
type: concept            # overview | source | concept | component | scenario | analysis
tags: [risk, physics]
sources: [codebase-a34844b]   # slugs of the source pages that back this page
updated: 2026-10-17           # UTC date of the last substantive edit
---
```

Source pages add `kind` (code | paper | article | dataset | notes) and `ingested`. They also add
either `commit` (code) or `origin` (URL or citation) plus `raw` (the path under `raw/`). Analysis pages
add `commit` when they report numbers from running the code.

**Body.**
- The first paragraph is a one-sentence summary, the same sentence index.md uses.
- Suggested sections. A concept page has Definition, Why it matters, In Aegis Orbit, Pitfalls and
  See also. A component page has Responsibility, How it works, Invariants and gotchas, Tests and See
  also. A scenario page has Setup, What happens, Numbers and See also. Omit empty sections; don't pad.
- Links are relative markdown links (`[Pc](../concepts/collision-probability.md)`), not `[[wikilinks]]`,
  so pages render on GitHub, in VS Code and in Obsidian alike.
- Code citations are clickable links relative to the page:
  `[screening.py:244](../../../backend/app/physics/screening.py#L244)`. Line numbers are valid at the
  commit of the codebase source page in `sources:`. Lint re-checks them against HEAD.

**Claims.**
- Every non-obvious claim cites a code location, a source page or an analysis page.
- A number obtained by running code cites the analysis page that recorded it, with its commit. Never
  write a number, ID or citation you did not read or measure.
- Domain knowledge from your own training, not from an ingested source, is marked *(background)*.
  Replace the marker with a citation once a raw source that covers it is ingested.
- When two sources disagree, keep both claims, cite both and add a `> [!warning] Contradiction`
  callout. Don't silently pick one.
- Units follow the code: km and km/s for states, m/s for Δv, metres for the hard-body radius and
  covariance sigmas. Times are UTC, ISO 8601 with `Z`.

## index.md

The catalog lists every wiki page except index.md itself. Pages are grouped by type and ordered by
reading value within a group. Each entry is one line:
`- [Title](path) — one-sentence summary · N sources · updated YYYY-MM-DD`. Update the index in the same
change that creates, renames or substantially changes a page.

## log.md

The log is append-only; never rewrite old entries. Each entry starts with
`## [YYYY-MM-DD] <op> | <subject>`, where `<op>` is one of `ingest`, `query`, `lint` or `schema`. Bullets
follow: what was read, which pages were created or updated, and what is still open. To see the five most
recent entries, run `grep "^## \[" wiki/log.md | tail -5`.

## Workflows

### Ingest (one source at a time)

1. The human adds a file to `raw/` (or names a commit for code) and asks for an ingest.
2. Read the whole source. For code, record `git rev-parse --short HEAD` and check `git status`. If the
   tree is dirty, say so and cite the commit plus "uncommitted changes".
3. Share the 3–5 key takeaways and what they change in the wiki. Wait for a go-ahead unless the human
   already gave one.
4. Write `sources/<slug>.md` covering the origin, a summary, key claims with their locations, what is
   new or contradictory relative to the wiki, and the pages touched.
5. Update or create the concept, component and scenario pages the source touches (often 5–15). Merge new
   information into the existing text rather than appending "update" sections, and flag contradictions.
6. Update `overview.md` if the big picture moved.
7. Update `index.md` and append to `log.md`.

### Re-ingest the codebase after it changes

1. Run `git diff --stat <old-sha>..HEAD`, where `<old-sha>` is the commit of the newest
   `sources/codebase-*.md`.
2. Write `sources/codebase-<new-sha>.md` summarising the delta, not the whole repository again.
3. Update the affected pages, their code citations and their `sources:` lists. Mark claims the change
   superseded.
4. Re-run any analysis whose numbers the change may have moved, as a new dated analysis page, and link
   the old page to the new one.

### Query

1. Read `index.md`, then the relevant pages. Open sources or code only for what the pages don't answer.
2. Answer with citations to wiki pages, plus code or raw locations where they're needed.
3. If the answer is reusable, offer to file it as `analyses/YYYY-MM-DD-slug.md`. Reusable means an
   explanation, a comparison, a measured result or a decision. Once you file it, update the index and
   the log. An answer can also take the form of a table, a Marp deck (`marp: true` frontmatter) or a
   chart saved under `analyses/assets/`.

### Lint

Run a lint when the human asks, or suggest one after every ~5 ingests. Report the findings first, then
fix them with the human's approval. Check for:

- contradictions between pages, and claims a newer source superseded
- broken links, orphan pages (no inbound links) and pages missing from `index.md`
- concepts that two or more pages mention but that have no page of their own
- code citations that no longer point at the code they describe (check against HEAD)
- *(background)* claims that an ingested raw source could now back
- gaps worth a web search or a new raw source. File new questions in `analyses/open-questions.md`.

## Hard rules

- Never edit `raw/` or application code as part of a wiki workflow. A bug found while ingesting goes in
  `analyses/open-questions.md`, and you tell the human about it.
- Never invent numbers, IDs, quotes or citations.
- When merging or renaming pages, update every inbound link and record the change in the log.
- Keep `index.md` and `log.md` in step with every change to `wiki/`.
- Once the wiki outgrows `index.md` (roughly 100+ pages), propose adding a local search tool such as
  [qmd](https://github.com/tobi/qmd) rather than reading the index alone.
