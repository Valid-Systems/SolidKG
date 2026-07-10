# Code intelligence capability record

This is the short, evidence-backed version of what SolidKG can do today. It is meant for README/site copy, release notes, and future claim checks. It should stay concrete: name the capability, the evidence source, and the known frontier.

Static analysis still has limits. Generated code, reflection, inherited framework magic, anonymous closures, and runtime-only dispatch can still require direct source inspection.

## Measured operating profile

| Evidence | Result | Source |
|---|---:|---|
| 37 language/framework flow-question cells, with SolidKG MCP vs no MCP | Reads fell `159 -> 38` (76% fewer), greps fell `72 -> 22`, tool calls fell `321 -> 189`, mean wall-clock `48s -> 38s`; no cell increased reads | `docs/benchmarks/solidkg-ab-matrix.md` |
| 7 README benchmark repos, median of 4 runs/arm | 46% faster wall-clock, 71% fewer tool calls, 57% fewer tokens, 35% lower cost | `docs/benchmarks/call-sequence-analysis.md` |
| 2026-07-10 exploratory OpenCode diagnostic, 7 repos × 3 arms × 4 repeats | CodeGraph used fewer tool calls and tokens than SolidKG in all 7 repository medians; unweighted average reductions were 58.6% and 58.9%. Missing raw/exact-binary provenance keeps this diagnostic, not claim-grade. | `docs/benchmarks/opencode-head-to-head-2026-07-10.md` |
| Large-reference stress suite | 118 local reference snapshots covering major OSS systems and language ecosystems | `docs/tested-codebases.md` |
| Source-body retrieval fixture | body-query, exact-query, generated/test demotion, no-match, and trace controls all passed at recall@5 `1.00`, MRR `1.00`, source-reference fidelity `1.00` | `.omo/evidence/retrieval-quality-codeseek-retrieval-improvements.md` |
| Aider/PageRank-style explore allocation fixture | MRR `0.50 -> 1.00`, files-to-cover `2 -> 1`, chars-to-cover `490 -> 253` | `.omo/evidence/retrieval-quality-codeseek-retrieval-improvements.md` |

The primary product metric is not token savings by itself. The useful outcome is that agents answer structural questions with fewer raw `Read`/`Grep`/shell rediscovery loops and fewer total turns.

## Core capabilities

- **AST-derived graph, not summaries.** Files become symbols, pairwise edges, semantic hyperedges, and optional SCIP facts stored locally in SQLite.
- **Structural tools for agents.** `trace`, `context`, `explore`, `search`, `callers`, `callees`, `impact`, `files`, `snapshot`, and `architecture` expose graph evidence without requiring broad filesystem scans.
- **Semantic hyperedges.** Route chains, event channels, UI render links, dynamic dispatch, native bridges, and type contracts preserve multi-symbol relationships that pairwise edges flatten.
- **Answer packets.** Tool output includes evidence anchors, ranking reasons, bounded uncertainty, sufficiency hints, and next-tool suggestions so agents know when to stop or continue.
- **Source-completeness labels.** Returned source is labeled as complete/partial/omitted/truncated/unreadable/skipped where applicable; this is returned-source coverage, not runtime proof.
- **Capability footprints.** Trace/node output can surface may-read/write/guard/emit/subscribe/send/mutate behavior with explicit coverage states.
- **Source-body chunk retrieval.** Indexed symbol bodies are stored as local derived chunks and searched with SQLite FTS5/code-token text, then fused into existing `context`, `explore`, and `search` ranking as `source_body_chunk` evidence. Exact symbol/path/trace/semantic/SCIP evidence stays higher-salience than body-only hits.
- **Graph-ranked explore allocation.** When exact file/symbol tiers do not settle an explore query, a bounded personalized file-graph ranking can prioritize the files most connected to the query evidence.
- **Overview projection.** `files --format overview` and `overview` provide a budgeted repository map from indexed facts, not a separate scanner.
- **Local-first default.** External embeddings, vector databases, rerankers, network calls, API keys, and telemetry are not enabled by default.

## Validated framework and dispatch coverage

The table records the evidence we still remember from the validation playbooks. It is intentionally phrased as measured coverage, not universal runtime equivalence.

| Area | What SolidKG connects | Representative validation repos |
|---|---|---|
| React / JS dynamic dispatch | observer callbacks, `setState -> render`, JSX child component flow, React Router v5/v6 component routing, literal object data-router routes | Excalidraw, react-realworld |
| Vue / Nuxt | SFC template event handlers, component composition, composable-destructure handler aliases | vitepress, vben, element-plus |
| Svelte / SvelteKit | template calls, `<Pascal/>` composition, `load -> api`, exported object-of-functions actions | realworld, skeleton, shadcn |
| Express / Koa-style routing | named handlers, middleware/controller/service calls, inline arrow route handler body calls | realworld, parse, Ghost |
| NestJS | HTTP/GraphQL/microservice/WebSocket decorators plus controller-to-service DI calls | realworld, immich, amplication |
| Django / DRF | URL patterns, CBV `.as_view()`, `router.register -> ViewSet`, ORM QuerySet descriptor flow | realworld, wagtail, saleor |
| Flask / FastAPI | routes across stacked/intervening decorators, empty-path router-root routes, Flask-RESTful resources, Jinja `TemplateResponse` links | fastapi-realworld, flask-microblog, Netflix dispatch, redash |
| Go web routers | Gin group variables, chi/gorilla/mux named handlers, `HandleFunc` patterns | gin-realworld, gin-vue-admin, gitness |
| Rust web frameworks | Axum chained methods and namespaced handlers, actix builder API, Rocket route attributes | realworld-axum, actix-examples, Rocket, crates.io |
| Spring / Java | bare method mappings plus class prefix, DI controller-to-service calls, interface-to-impl dispatch, OpenFeign and config-key links | spring-realworld, mall, halo |
| Kotlin | Spring Boot routes/actions and Compose static composition | petclinic-kotlin, Jetcaster |
| ASP.NET Core | feature-folder controller detection, bare `[HttpGet]` with class `[Route]` prefix, MVC `View()` to Razor links | aspnet-realworld, eShopOnWeb, jellyfin |
| Rails | explicit routes and RESTful `resources`/`resource` expansion to `controller#action` | realworld, spree, forem |
| Laravel | precise `Route::get([Ctrl::class, 'm'])`, `Ctrl@m`, and `Route::resource` controller actions | realworld, firefly, bookstack |
| Drupal | `*.routing.yml` handlers, FQCN/single-colon controller services, bare form FQCNs, module detection, hooks/plugins | admin_toolbar, webform, drupal-core |
| Swift Vapor | grouped builders, optional/non-string path segments, `use:` handlers | vapor-template, SteamPress, SwiftPackageIndex-Server |
| C/C++ | direct cross-file calls, C++ inheritance, virtual override synthesis | Redis, LevelDB |
| Dart / Flutter | method body ranges, `setState -> build`, static widget composition | Flutter counter fixtures, flutter_module_books, compass_app |
| Lua / Luau | module-heavy `require()` and `mod.fn()` flows; Roblox instance-path requires | telescope.nvim, lualine.nvim, Knit |
| Scala Play | extensionless `conf/routes` to controller actions | computer-database, Play starter |
| Swift / Objective-C bridge | Swift `@objc` naming, ObjC selectors, property getter/setter pairs | Charts, realm-swift, wikipedia-ios |
| React Native legacy bridge | JS `NativeModules.X.fn()` to ObjC `RCT_EXPORT_METHOD` / JVM `@ReactMethod` | AsyncStorage, react-native-firebase |
| React Native events | native event emitters to JS `addListener()` subscribers for literal event names | RNFirebase, RNGeolocation |
| Expo Modules | JS `requireNativeModule('X').fn()` to Swift/Kotlin `Function` / `AsyncFunction` declarations | expo-haptics, expo-camera, Expo SDK sweep |
| React Native Fabric / Paper views | JSX component to Codegen/Paper component declarations and native view-manager classes | RNSegmentedControl, RNScreens, RNSkia |
| Java enterprise mappings | MyBatis `SqlSessionTemplate` statement IDs to namespace-qualified XML mappings | Java enterprise fixtures documented in site docs |

## Known frontiers to keep honest

- Anonymous closures and handler literals are only covered where a resolver has a narrow, validated extraction rule.
- Reactive runtimes such as Vue Proxy reactivity, Compose recomposition, EF Core LINQ/DbSet, Eloquent/ActiveRecord dynamic finders, Spring Data derived queries, and GraphQL resolver inheritance remain frontier areas.
- Some framework-specific route abstractions are intentionally deferred when the static pattern is too custom or too noisy.
- Source-body chunk retrieval stores more local source text under `.solidkg/` than metadata-only indexing. It remains local, but that privacy/security sensitivity should be stated when relevant.

## Evidence files to update when claims change

- `docs/benchmarks/solidkg-ab-matrix.md`
- `docs/benchmarks/call-sequence-analysis.md`
- `docs/benchmarks/opencode-head-to-head-2026-07-10.md`
- `docs/tested-codebases.md`
- `docs/design/dynamic-dispatch-coverage-playbook.md`
- `docs/design/claims-register.md`
- `.omo/evidence/retrieval-quality-codeseek-retrieval-improvements.md`
- `.omo/evidence/final-codeseek-retrieval-improvements-*.md`
