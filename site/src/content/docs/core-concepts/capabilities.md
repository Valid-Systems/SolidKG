---
title: Capability Record
description: Evidence-backed summary of SolidKG's code-intelligence surface.
---

This page is the concise, claim-safe summary of what SolidKG can do today. It names the feature, the evidence source, and the frontier rather than treating static analysis as runtime proof.

## Measured profile

| Evidence | Result |
|---|---:|
| 37 language/framework flow-question cells, with SolidKG MCP vs no MCP | Reads fell `159 -> 38`, greps fell `72 -> 22`, tool calls fell `321 -> 189`, mean wall-clock `48s -> 38s`; no cell increased reads |
| 7 README benchmark repos, median of 4 runs/arm | 46% faster wall-clock, 71% fewer tool calls, 57% fewer tokens, 35% lower cost |
| 2026-07-10 exploratory OpenCode diagnostic, 7 repos × 3 arms × 4 repeats | CodeGraph used fewer tool calls and tokens than SolidKG in every repository median; missing raw/exact-binary provenance keeps this diagnostic, not claim-grade |
| Source-body retrieval fixture | body-query, exact-query, generated/test demotion, no-match, and trace controls all passed at recall@5 `1.00`, MRR `1.00`, source-reference fidelity `1.00` |
| Aider/PageRank-style explore allocation fixture | MRR `0.50 -> 1.00`, files-to-cover `2 -> 1`, chars-to-cover `490 -> 253` |

The primary product metric is fewer raw `Read`/`Grep`/shell rediscovery loops and fewer total turns for structural questions. Token outcomes vary by model and harness: they improved in the earlier Claude A/B but increased for SolidKG in the 2026 OpenCode diagnostic. Dollar cost was unavailable under the OpenAI subscription path.

## Core surface

- AST-derived graph facts: symbols, files, imports, calls, references, inheritance, semantic hyperedges, and optional SCIP references.
- Structural agent tools: the compact/default MCP profile exposes only answer-producing `explore`; `SOLIDKG_MCP_TOOLS=all` restores `trace`, `context`, `search`, `callers`, `callees`, `impact`, `files`, `snapshot`, and `architecture` for explicit workflows.
- Answer packets with evidence anchors, ranking reasons, bounded uncertainty, returned-source coverage, sufficiency hints, and next-tool guidance.
- Capability footprints for may-read/write/guard/emit/subscribe/send/mutate behavior where the capability producer has coverage.
- Source-body chunk retrieval through local SQLite FTS5/code-token text, surfaced as `source_body_chunk` evidence in existing tools.
- Graph-ranked file allocation for explore queries after exact file/symbol tiers.
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
