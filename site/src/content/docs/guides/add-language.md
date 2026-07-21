---
title: Add a Language
description: Contributor checklist for adding tree-sitter language support to SolidKG.
---

This guide is for contributors adding a new tree-sitter-backed language. The repository source of truth is the local `add-lang` skill at `.claude/skills/add-lang/SKILL.md`; this page summarizes the repeatable workflow and links to the deeper cookbook in `docs/add-language-support.md`.

A language isn't supported just because a parser exists. It is supported after SolidKG can discover its files, load a healthy native grammar, extract real graph nodes and edges, stage the parser library for every release target, pass tests, update docs, and validate on small, medium, and large real repositories.

## Required surfaces

| Surface | File or command |
|---|---|
| Language token | `src/types.ts` `LANGUAGES` |
| Extension mapping | `src/extraction/grammars.ts` `EXTENSION_MAP` |
| Native grammar mapping | `src/extraction/native-grammars.json` |
| Host parser staging | `pnpm run prepare:native-runtime` |
| Extractor | `src/extraction/languages/<lang>.ts` |
| Extractor registration | `src/extraction/languages/index.ts` `EXTRACTORS` |
| Tests | `__tests__/extraction.test.ts` |
| Real-repo corpus | `.claude/skills/agent-eval/corpus.json` |
| Public docs | `README.md` and this docs site |

Current file discovery is driven by `EXTENSION_MAP` plus special file rules such as Play `conf/routes`. Verify the current source before adding another allowlist.

## Workflow

1. Resolve the lowercase language token and check whether it already appears in `LANGUAGES`, `EXTRACTORS`, `native-grammars.json`, and `EXTENSION_MAP`.
2. Confirm the pinned `@xberg-io/tree-sitter-language-pack` catalog contains the grammar, add its package/library mapping, and run `pnpm run prepare:native-runtime`.
3. Run `node scripts/add-lang/check-grammar.mjs <lang> path/to/valid-sample.<ext>` before writing the extractor. A parser that fails on valid code must not ship.
4. Dump the AST with `node scripts/add-lang/dump-ast.mjs <lang> path/to/sample.<ext>` and map the real node and field names.
5. Write `src/extraction/languages/<lang>.ts` using an existing extractor as a model. `rust.ts` is a compact example for functions, traits, structs, imports, variables, signatures, and receiver types. `lua.ts` is the example for call-shaped imports.
6. Register the extractor in `src/extraction/languages/index.ts`.
7. Build with `pnpm run build`; it stages the host native parsers and copies `native-grammars.json` into `dist/extraction/`.
8. Index a sample repo with `node dist/bin/solidkg.js init -i path/to/sample-repo` and run `node scripts/add-lang/verify-extraction.mjs path/to/sample-repo <lang>` until it passes.
9. Add `__tests__/extraction.test.ts` coverage for detection and inline source extraction, then run `pnpm exec vitest run __tests__/extraction.test.ts`.
10. Pick small, medium, and large real repositories and run deterministic extraction plus public trace/node/context/explore probes for each one.
11. If the language or framework has dynamic-dispatch flows, verify end-to-end traces, synthesized-edge provenance, and stable node/hyperedge counts before claiming flow coverage.
12. Update docs with only the support that tests and evaluation prove.

## Mapping rules

Use existing graph kinds. Language-specific syntax must map to the shared `NodeKind` and `EdgeKind` vocabulary in `src/types.ts`. For example, traits use `trait`, methods use `method`, module imports use `import`, and calls use `calls`. Don't add a new kind string unless the graph model itself is changing.

If the generic extractor can't find a grammar shape, add the narrowest possible branch in `src/extraction/tree-sitter.ts`. Don't add broad fallback behavior just to make one sample pass.

## Validation bar

A complete language task reports:

1. `pnpm run build` result.
2. `pnpm run prepare:native-runtime` result when native grammar coverage changed.
3. Focused extraction test result.
4. `verify-extraction.mjs` result for each real repo.
5. A/B results for each real repo, with and without SolidKG, including tool calls, file Reads, Grep/Bash use, SolidKG calls, duration, cost, and answer quality.
6. Known gaps, such as anonymous callbacks, dynamic imports, generated code, framework route patterns, or metaprogramming.

Read the full contributor cookbook at [`docs/add-language-support.md`](https://solidkg.local/repository/blob/main/docs/add-language-support.md) before starting implementation.
