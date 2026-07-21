# Add Language Support Cookbook

This cookbook is for contributors adding a new tree-sitter-backed language to SolidKG. Use it together with the local `add-lang` skill at `.claude/skills/add-lang/SKILL.md`. That skill is the execution checklist. This document explains what each step must prove before a language can be called supported.

A language is not supported when a parser exists. It is supported only after SolidKG can find the files, load a healthy native grammar, extract useful graph nodes and edges, stage the parser library for every release target, pass tests, appear in docs, and validate on real repositories.

## What Support Means

A complete language change covers these surfaces:

1. The language token is in `src/types.ts` `LANGUAGES`.
2. Extensions map to that token in `src/extraction/grammars.ts` `EXTENSION_MAP`.
3. A grammar entry exists in `src/extraction/native-grammars.json`, and `pnpm run prepare:native-runtime` stages its shared library for the host platform.
4. A language extractor exists in `src/extraction/languages/<lang>.ts` and is registered in `src/extraction/languages/index.ts` `EXTRACTORS`.
5. Extracted symbols use existing `NodeKind` and `EdgeKind` values from `src/types.ts`; don't invent new kind strings for language-specific concepts.
6. `__tests__/extraction.test.ts` covers language detection and extraction from inline source.
7. README and site language docs list only the support that tests and validation prove.
8. Three real repositories, small, medium, and large, pass extraction verification and agent evaluation.

Current file discovery is driven by `EXTENSION_MAP` plus special file rules such as Play `conf/routes`. The local `add-lang` skill may mention older include allowlists. In this codebase, verify the actual scanner behavior before editing, and don't add a second allowlist unless the source code has one.

## Repeatable Workflow

### 1. Resolve the language token

Use the lowercase single token that should appear in the `Language` union, for example `lua`, `elixir`, or `zig`. Check whether it's already wired before changing files:

```bash
rg "'<lang>'|<lang>:" src/types.ts src/extraction/languages/index.ts src/extraction/grammars.ts
```

If the language is already present in `LANGUAGES`, `EXTRACTORS`, `native-grammars.json`, and `EXTENSION_MAP`, don't reimplement it. Run the validation and benchmark steps instead.

### 2. Find and health-check the grammar

Confirm that the pinned `@xberg-io/tree-sitter-language-pack` catalog contains the language, then add its package and native library names to `src/extraction/native-grammars.json`. Stage the current platform's library and health-check it before writing an extractor:

```bash
pnpm run prepare:native-runtime
node scripts/add-lang/check-grammar.mjs <lang> path/to/valid-sample.<ext>
```

The check disables runtime downloads, loads the parser from `.native-grammars/<platform>-<arch>`, and parses the valid sample repeatedly. If the pinned package does not provide a loadable native library or valid code produces error trees, stop. Update the pinned dependency deliberately rather than adding an untracked parser binary or a runtime download path.

Stop if you can't get a healthy grammar. Don't ship a half-wired language.

### 3. Discover the AST shape

Dump a representative sample before writing mappings:

```bash
node scripts/add-lang/dump-ast.mjs <lang> path/to/sample.<ext>
```

The frequency table and field names tell you what to map for `nameField`, `paramsField`, `bodyField`, `returnField`, imports, calls, variables, classes, structs, interfaces, enums, and type aliases.

Use an existing extractor as the first model:

| Language family                     | Example extractor                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Functional or trait-heavy languages | `src/extraction/languages/rust.ts` or `src/extraction/languages/scala.ts`                                      |
| OO languages                        | `src/extraction/languages/java.ts` or `src/extraction/languages/csharp.ts`                                     |
| Scripting languages                 | `src/extraction/languages/python.ts`, `src/extraction/languages/ruby.ts`, or `src/extraction/languages/lua.ts` |
| Receiver-based methods              | `src/extraction/languages/go.ts`                                                                               |

`rust.ts` is a compact example of mapping functions, traits, structs, enums, imports, variables, signatures, visibility, and receiver type. `lua.ts` is a good example when imports are represented as calls and variable extraction needs a language-specific branch.

### 4. Wire the core language files

Make the small wiring edits first:

1. Add the token to `LANGUAGES` in `src/types.ts` before `unknown`.
2. Add the package and native library names to `src/extraction/native-grammars.json`.
3. Add every extension to `EXTENSION_MAP` in `src/extraction/grammars.ts`.
4. Add a display name branch in `getLanguageDisplayName` in `src/extraction/grammars.ts`.
5. Create `src/extraction/languages/<lang>.ts` exporting `<lang>Extractor`.
6. Import and register the extractor in `src/extraction/languages/index.ts`.

Extractor mappings must use the shared graph vocabulary. Map language-specific declarations to the nearest existing `NodeKind`, such as `function`, `method`, `class`, `struct`, `interface`, `trait`, `enum`, `enum_member`, `type_alias`, `import`, `variable`, `constant`, `property`, and `field`. Calls and references should become existing `EdgeKind` values such as `calls`, `imports`, `contains`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, and `decorates`.

If the grammar nests declared names in a way the generic extractor can't find, add a narrow branch in `src/extraction/tree-sitter.ts` rather than broad fallback code. Lua's `variable_declaration` handling is the pattern: the extractor maps the node, while the core has a language branch only for the grammar shape the generic path can't read.

### 5. Build and verify extraction locally

Run the build so TypeScript, schema/native metadata, and the host's native parser libraries are all checked:

```bash
pnpm run build
```

For a fast metadata copy after changing only the schema or native grammar map, run:

```bash
pnpm run copy-assets
```

Then index a sample repo with the built CLI and verify that extraction found more than file or import nodes:

```bash
node dist/bin/solidkg.js init -i path/to/sample-repo
node scripts/add-lang/verify-extraction.mjs path/to/sample-repo <lang>
```

If verification fails or looks thin, dump the AST from a richer file, adjust the extractor, rebuild, reindex, and rerun verification. Repeat until it passes.

### 6. Add focused tests

Add two kinds of coverage to `__tests__/extraction.test.ts`:

1. A `detectLanguage` assertion in `describe('Language Detection')`.
2. A `describe('<Lang> Extraction')` block that extracts inline source and asserts real symbols, imports, and calls where the language supports them.

Run the focused test file:

```bash
pnpm exec vitest run __tests__/extraction.test.ts
```

If you document a narrower focused command in a pull request, make sure it is valid from the repository root. Keep tests honest. If a language only has file-level tracking, don't claim functions or classes.

### 7. Validate on real repositories

Pick three popular repositories without asking, one per size tier:

| Tier   | Target indexed files |
| ------ | -------------------- |
| Small  | Fewer than about 150 |
| Medium | About 150 to 1500    |
| Large  | More than about 1500 |

Use GitHub search to find candidates, then curate for repositories that are genuinely dominated by the target language:

```bash
gh search repos --language=<lang> --sort=stars --limit 40 --json fullName,stargazerCount,description
```

Run extraction validation with the local dev build:

```bash
pnpm run build
./scripts/local-install.sh
node scripts/add-lang/verify-extraction.mjs <repo> <lang>
node scripts/agent-eval/probe-explore.mjs <repo> "<cross-file question>"
```

Repeat on small, medium, and large repositories. For framework or dynamic-dispatch coverage, use the public trace/node/context/explore probes, check synthesized edge provenance and stable node/hyperedge counts, and record any known gaps conservatively. The unpublished A/B harness and raw evidence are not part of the initial public archive.

### 8. Update user-facing docs

Update docs only for what the code now proves:

1. `README.md` `Supported Inputs`.
2. `site/src/content/docs/reference/languages.md`.
3. Any relevant guide or benchmark matrix if the work changes validation guidance.
4. Update user-facing docs when the language support changes public behavior. Don't bump package versions.

Use conservative wording. For example, CUDA files are currently mapped through the C++ parser, so docs must not claim CUDA kernel-launch semantic extraction. YAML, Twig, and Lazarus `.lpi` are file-level records unless a framework resolver adds richer nodes.

### 9. Report the evidence

A complete handoff should include:

1. Files changed, including `src/extraction/native-grammars.json` when parser coverage changed.
2. Extraction results per real repo: files, nodes, edges, and `verify-extraction` status.
3. A/B results per real repo: with vs without SolidKG, tool calls, file Reads, Grep/Bash, SolidKG calls, duration, cost, and correctness verdict.
4. Gaps, such as anonymous callbacks, dynamic imports, generated code, framework route forms, or metaprogramming that stayed out of scope.

Never commit, push, tag, publish, or claim release readiness from the language task. Leave the changes for review.

## Quick Preflight Checklist

Copy this into the language task and check it off:

```text
[ ] Token resolved and not already supported, or already supported and benchmark-only path chosen
[ ] Grammar is available from the pinned native language pack
[ ] Grammar health-check passes on valid code
[ ] AST dump reviewed from representative sample
[ ] src/types.ts LANGUAGES updated
[ ] src/extraction/native-grammars.json updated
[ ] src/extraction/grammars.ts EXTENSION_MAP updated
[ ] src/extraction/grammars.ts display name updated
[ ] src/extraction/languages/<lang>.ts added with NodeKind and EdgeKind mappings
[ ] src/extraction/languages/index.ts EXTRACTORS updated
[ ] Narrow tree-sitter core branch added only if the grammar shape requires it
[ ] pnpm run build passes
[ ] pnpm run prepare:native-runtime stages the host parser library
[ ] pnpm run copy-assets verified when schema or native grammar metadata changed
[ ] verify-extraction.mjs passes on a sample repo
[ ] __tests__/extraction.test.ts detection and extraction tests pass
[ ] README and site language docs updated with conservative claims
[ ] User-facing docs updated when needed
[ ] Small, medium, and large repositories pass deterministic extraction probes
[ ] Public trace/node/context/explore probes cover any framework flow gaps
[ ] Final report includes extraction results and known gaps without unpublished performance claims
```
