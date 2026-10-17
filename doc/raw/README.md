# raw/: source documents

This folder holds the sources you want the wiki to learn from: papers, articles, handbooks, notes,
datasets and screenshots. The agent reads these files during an ingest and never modifies them.

- Name files `YYYY-MM-DD-short-slug.ext`, where the date is when you added the file.
- Put images in [`assets/`](assets/) and reference them from markdown sources with relative paths.
- Prefer markdown or PDF. The Obsidian Web Clipper converts web pages to markdown.
- Add one source at a time, then ask for an ingest (see [`../CLAUDE.md`](../CLAUDE.md)).

The repository's own code is not copied here. The wiki cites it in place, at a pinned commit.

Suggested first sources (they would back the wiki's *(background)* claims) are listed in
[`../wiki/analyses/open-questions.md`](../wiki/analyses/open-questions.md#sources-worth-adding).
