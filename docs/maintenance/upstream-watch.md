# Upstream Watch

This repository keeps a small amount of ancestry-sensitive code and guidance that may still overlap with `colbymchenry/codegraph`. Use this protocol to notice upstream releases, review only relevant deltas, and keep a durable record of the last upstream release reviewed.

Upstream is a reference feed, not an authority for this checkout. This fork has advanced local behavior that upstream may not have, so an upstream change must be adapted only when it preserves or improves the local behavior documented in `docs/maintenance/upstream-divergence.md`.

The protocol is read-only until a maintainer explicitly chooses a follow-up patch. It must not merge, cherry-pick, rebase, push, tag, publish, or rewrite local work.

## Tracking Files

- `.upstream-watch/state.json` records the upstream repository and the last upstream release reviewed.
- `.upstream-watch/mirrored-paths.txt` lists local path patterns that still overlap upstream enough to require triage.
- `.upstream-watch/reports/*.md` records the durable action report for each reviewed upstream range.
- `scripts/upstream-watch/report.mjs` filters GitHub compare JSON through the manifest and prints a Markdown report.
- `docs/maintenance/upstream-divergence.md` records protected local divergence areas that an upstream update must not regress.

Update `lastReviewedRelease` only after a maintainer has reviewed the generated report and release notes. Save a report under `.upstream-watch/reports/` for the exact reviewed range before updating the state file, even when the release has no relevant changes.

## Manual Invocation

First ensure the upstream remote exists:

```bash
git remote add upstream https://github.com/colbymchenry/codegraph.git
git fetch upstream --tags --prune
```

If `upstream` already exists, run only the fetch command.

Find the latest upstream release:

```bash
gh release list --repo colbymchenry/codegraph --limit 5
```

Generate a filtered report from the last reviewed release to the latest release:

```bash
gh api repos/colbymchenry/codegraph/compare/v0.9.5...v0.9.9 \
  | node scripts/upstream-watch/report.mjs --base v0.9.5 --head v0.9.9
```

Replace `v0.9.5` with `.upstream-watch/state.json.lastReviewedRelease` and replace `v0.9.9` with the latest upstream release tag.

## Agent Review Contract

When asked to review upstream updates:

1. Read `AGENTS.md`, this document, `docs/maintenance/upstream-divergence.md`, `.upstream-watch/state.json`, and `.upstream-watch/mirrored-paths.txt` first.
2. Fetch upstream tags without merging.
3. Generate the filtered report with `scripts/upstream-watch/report.mjs`.
4. Read the upstream release notes for every release in the reviewed range.
5. Inspect local files only for matched manifest paths or directly related behavior.
6. Produce a triage report with relevant upstream changes, protected divergence areas touched, local files affected, recommended action, and risk level.
7. Save the triage report under `.upstream-watch/reports/<base>-to-<head>.md` before any state update.
8. Do not update `.upstream-watch/state.json` unless the maintainer explicitly confirms the release range is reviewed.

If the report identifies MCP tool behavior, installer targets, extraction, resolution, release packaging, or agent instructions, run the existing protected validation gates for those surfaces before proposing code changes. Default to `investigate` or `reject-as-regression` when upstream conflicts with the divergence register.

## Manifest Maintenance

Keep `.upstream-watch/mirrored-paths.txt` conservative and explicit. Add paths when local code still substantially mirrors upstream or when upstream changes could invalidate local assumptions. Remove paths only after confirming the local surface no longer depends on upstream behavior.

Broad patterns are acceptable for high-risk surfaces such as `src/mcp/**`, `src/installer/**`, `src/extraction/**`, and `src/resolution/**`. Avoid adding generated output, dependency directories, temporary files, or local-only evidence artifacts.

## Automation Shape

A future GitHub Action or local scheduled task should do only this:

1. Read `.upstream-watch/state.json`.
2. Query the latest upstream release via `gh api repos/colbymchenry/codegraph/releases/latest` or `gh release list`.
3. If the latest release differs from `lastReviewedRelease`, run the compare command and report helper.
4. Save or post the report for maintainer review.

Automation must not update the state file by itself. It also must not merge, cherry-pick, commit, push, create tags, publish packages, or trigger the release workflow.
