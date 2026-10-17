# Aegis Orbit wiki

A knowledge base about Aegis Orbit and orbital collision avoidance, written and maintained by an LLM
agent following Andrej Karpathy's
[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) pattern.

Start reading at **[wiki/overview.md](wiki/overview.md)**. Every page is listed in
**[wiki/index.md](wiki/index.md)**.

## How it works

The wiki has three layers:

| Layer | What it is | Who writes it |
|---|---|---|
| [`raw/`](raw/) | Source documents (papers, articles, notes, images). Never modified. | You |
| [`wiki/`](wiki/) | Interlinked markdown pages: summaries, concepts, components, scenarios, analyses. | The agent |
| [`CLAUDE.md`](CLAUDE.md) | The schema: page formats, citation rules and the ingest/query/lint workflows. | You and the agent together |

The repository's code is a source too. The agent reads it at a pinned commit and cites it by file and
line, so code pages say exactly which version they describe.

Knowledge compounds here rather than being re-derived on every question. When a source arrives, the
agent folds it into the existing pages, updates the cross-references and flags contradictions. When a
question gets a good answer, that answer is filed back as a page.

## Using it with Claude Code

Claude Code reads `doc/CLAUDE.md` automatically when it works in this folder. Typical requests:

| You want to… | Say |
|---|---|
| Add a source | *"Ingest `raw/2026-10-20-cara-handbook.pdf` into the wiki."* |
| Catch up with code changes | *"Re-ingest the codebase at HEAD."* |
| Ask something | *"Using the wiki, why does the planner never pick a cross-track burn?"* |
| Keep a good answer | *"File that as an analysis."* |
| Health-check | *"Lint the wiki."* |

Other agents (Codex, OpenCode …) work too. Point them at `doc/CLAUDE.md` as their instructions.

## Reading it in Obsidian (optional)

Open `doc/` as a vault, then:

- **Settings → Files and links**: turn off *Use [[Wikilinks]]* and set *New link format* to
  *Relative path to file*, so new links match the existing ones.
- **Default location for new attachments**: `raw/assets`. The
  [Obsidian Web Clipper](https://obsidian.md/clipper) turns web articles into markdown you can save
  into `raw/`.
- **Graph view** shows hub pages and orphans.
- With the Dataview plugin, frontmatter becomes queryable:

  ````
  ```dataview
  TABLE type, updated, length(sources) AS sources
  FROM "wiki"
  SORT updated DESC
  ```
  ````
