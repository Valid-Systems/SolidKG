---
title: Framework Routes
description: SolidKG links URL patterns to the handlers that serve them.
---

SolidKG detects web-framework routing files and emits `route` nodes linked by `references` edges to their handler classes or functions. Querying the callers of a view or controller then surfaces the URL pattern that binds it.

| Framework | Shapes recognized |
|---|---|
| **Django** | `path()`, `re_path()`, `url()`, `include()` in `urls.py` (CBV `.as_view()`, dotted paths) |
| **Flask** | `@app.route('/path', methods=[…])`, blueprint routes |
| **FastAPI** | `@app.get(…)`, `@router.post(…)`, all standard methods; static `TemplateResponse("template.html", …)` route bindings to Jinja2 files |
| **Express** | `app.get(…)`, `router.post(…)` with middleware chains |
| **Hono** | `app.get(…)`, `router.post(…)`, mounted `app.route('/prefix', subRouter)` paths |
| **NestJS** | `@Controller` + `@Get/@Post/…`, GraphQL resolvers, message/event patterns, WebSocket subscriptions |
| **Laravel** | `Route::get()`, `Route::resource()`, `Controller@action`, tuple syntax |
| **Drupal** | `*.routing.yml` routes; procedural `hook_*` implementations; Drupal 11 `#[Hook]` methods; common plugin annotations/attributes |
| **Rails** | `get '/x', to: 'users#index'`, hash-rocket syntax |
| **Spring** | `@GetMapping`, `@PostMapping`, `@RequestMapping` on methods; conservative OpenFeign to RestController links; `@ConditionalOnProperty` config keys |
| **Gin / chi / gorilla / mux** | `r.GET(…)`, `router.HandleFunc(…)` |
| **Axum / actix / Rocket** | `.route("/x", get(handler))` |
| **ASP.NET** | `[HttpGet("/x")]` attributes on action methods; static MVC `View()` / `View("Name")` references to Razor files |
| **Vapor** | `app.get("x", use: handler)` |
| **React Router** / **SvelteKit** | Route component nodes |

Route resolution is automatic. There's nothing to configure. If a framework file is recognized, its routes appear in the graph after the next index or sync.

Static Java enterprise coverage also links `SqlSessionTemplate` string-literal statement IDs to namespace-qualified MyBatis XML mappings when the target is unique. Template and framework links are static only; SolidKG doesn't execute FastAPI, Jinja2, ASP.NET, Razor, Spring, MyBatis, Hono, or Drupal runtimes.
