---
title: Capability Record
description: Evidence-backed summary of SolidKG's code-intelligence surface.
---

This page is the concise, claim-safe summary of what SolidKG can do today. It names the feature, the evidence source, and the frontier rather than treating static analysis as runtime proof.

## OpenAI/OpenCode comparison

| Measure | SolidKG | CodeGraph |
|---|---:|---:|
| Tool calls, equal-repository aggregate | 16.7% lower | Baseline |
| Tokens, equal-repository aggregate | 15.9% lower | Baseline |
| Read / Grep / Glob | 0 median in all 7 repositories | 0 median in all 7 repositories |
| Repeats per repository | 4 | 4 |

Scope: 56 successful runs across seven repositories, two products, and four repeats. Every answer cited source files; 54/56 matched every expected mechanism. Elapsed time is omitted because cells ran concurrently on a busy host. Dollar cost was unavailable through the OpenAI subscription path.

## Expanded OpenAI/OpenCode corpus

| Equal-repository reduction for SolidKG | Result |
|---|---:|
| Tool calls | 34.6% |
| Read calls | 24.0% |
| Grep calls | 77.8% |
| Glob calls | 100.0% |
| Graph calls | 12.5% |
| Tokens | 34.7% |

This July 11 local comparison used Cartog, Tilth, Azure PowerShell, and Apache Airflow with `openai/gpt-5.6-sol` and four repeats per repository/product cell. All 32 runs completed with zero tool errors and source-file citations. The mechanism screen completed 31/32 checks. A separate audit passed all eight median-representative answers; one non-representative Cartog/SolidKG answer was partial because it omitted the Git-diff stage.

Cartog and Tilth used pinned commits. Azure PowerShell and Apache Airflow were unversioned local snapshots, so this report does not make an independent-reproduction or claim-grade assertion for those rows. The observed 3.3% wall-clock reduction is excluded because concurrent subscription-host timing is descriptive rather than controlled.

## Retrieval diagnostics

| Diagnostic | Result |
|---|---:|
| Source-body retrieval fixture | Recall@5 `1.00` · MRR `1.00` · source-reference fidelity `1.00` |
| Graph-ranked allocation fixture | MRR `0.50 -> 1.00` · files-to-cover `2 -> 1` · chars-to-cover `490 -> 253` |
| Graded default-surface probes | 4/4 ordinary required-source hits · 2/2 calibrated counterfactual abstentions · 0 misleading intrusions |

The primary product metric is fewer raw `Read`/`Grep`/shell rediscovery loops and fewer total turns for structural questions.

## Core surface

- AST-derived graph facts: symbols, files, imports, calls, references, inheritance, semantic hyperedges, and optional SCIP references.
- Structural agent tools: the compact/default MCP profile exposes only answer-producing `solidkg_explore`; `SOLIDKG_MCP_TOOLS=all` restores `solidkg_search`, `solidkg_context`, `solidkg_trace`, `solidkg_node`, `solidkg_callers`, `solidkg_callees`, `solidkg_impact`, `solidkg_files`, `solidkg_status`, `solidkg_snapshot`, `solidkg_architecture`, and `solidkg_precise_refs` for explicit workflows.
- Answer packets with evidence anchors, ranking reasons, bounded uncertainty, returned-source coverage, sufficiency hints, and next-tool guidance.
- Counterfactual concept coverage: explicit exclusions are constraints; uncovered positive concepts produce a partial `missing_query_concept` packet instead of false sufficiency.
- Capability footprints for may-read/write/guard/emit/subscribe/send/mutate behavior where the capability producer has coverage.
- Source-body chunk retrieval through local SQLite FTS5/code-token text, surfaced as `source_body_chunk` evidence in existing tools.
- Graph-ranked file allocation for explore queries after exact file/symbol tiers.
- Large-index lifecycle diagnostics: `index` and the initial index run by `init -i` expose source projection as a visible phase, flushing at 128 files or 32 MiB. Source chunks are limited to 8 KiB with a 1,024-chunk-per-file safety cap. The lifecycle record at `<data-dir>/index-lifecycle.json` is atomically replaced through a random exclusive temporary file. Phase, detail, completion, and terminal success or failure are persisted immediately. Running counts are periodically checkpointed with an intended lag of at most about two seconds, so they reflect the latest checkpoint rather than the instant you inspect the file. The record is owner-only where POSIX modes apply and may contain absolute paths or stack traces.
- Local-first defaults: indexing and graph retrieval do not enable external embeddings, vector databases, rerankers, network calls, API keys, or telemetry. An AI coding-agent host may still send returned source snippets to its configured model provider.

## Validated coverage examples

| Area | Representative validation repos |
|---|---|
| React / observer / EventEmitter / React Router flows | Excalidraw, react-realworld |
| Vue / Nuxt template events and composition | vitepress, vben, element-plus |
| Svelte / SvelteKit template calls and actions | realworld, skeleton, shadcn |
| Express inline/named route handlers | realworld, parse, Ghost |
| NestJS decorators and DI controller-to-service calls | realworld, immich, amplication |
| Django / DRF URL, ViewSet, and ORM paths | realworld, wagtail, saleor |
| Flask / FastAPI routes and Flask-RESTful resources | fastapi-realworld, flask-microblog, Netflix dispatch, redash |
| Gin / chi / gorilla / mux route handlers | gin-realworld, gin-vue-admin, gitness |
| Rust Axum / actix / Rocket routes | realworld-axum, actix-examples, Rocket, crates.io |
| Spring / Java route, DI, and interface dispatch | spring-realworld, mall, halo |
| ASP.NET Core feature-folder controllers and attribute routes | aspnet-realworld, eShopOnWeb, jellyfin |
| Rails and Laravel controller route precision | Rails realworld/spree/forem; Laravel realworld/firefly/bookstack |
| Drupal routing, handlers, hooks, and plugins | admin_toolbar, webform, drupal-core |
| Swift Vapor route builders | vapor-template, SteamPress, SwiftPackageIndex-Server |
| Swift/Objective-C and React Native bridges | Charts, realm-swift, wikipedia-ios, AsyncStorage, react-native-firebase |
| Expo Modules and Fabric/Paper view bridges | expo-haptics, expo-camera, RNSegmentedControl, RNScreens, RNSkia |

For the fuller internal record, including known limits and source evidence files, see `docs/code-intelligence-capabilities.md` in the repository.

## Known frontiers

Anonymous closures, runtime reflection, reactive runtimes, dynamic finders, inherited framework magic, and highly custom route abstractions may still require direct source inspection. SolidKG should surface uncertainty rather than fabricate a path.
