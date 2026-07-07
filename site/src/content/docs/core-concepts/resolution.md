---
title: Resolution & Frameworks
description: How SolidKG connects references and links routes to handlers.
---

Extraction produces nodes and raw edges. **Resolution** turns names into real connections.

## Reference resolution

After parsing, SolidKG resolves:

- **Imports** to the source files they point at, including tsconfig path aliases and cargo workspace members.
- **Calls** to definitions, by import resolution and name matching.
- **Inheritance** through `extends` and `implements` relationships.

## Framework awareness

SolidKG recognizes web-framework routing files and emits `route` nodes linked by `references` edges to their handler classes or functions. Querying the callers of a view or controller then surfaces the URL pattern that binds it. See [Framework Routes](/solidkg/guides/framework-routes/) for the full list of recognized frameworks.

Static framework coverage includes conservative links for Hono mounted sub-routers, Drupal routing/hooks/plugins, FastAPI `TemplateResponse` to Jinja2 files, ASP.NET MVC `View()` to Razor files, Spring OpenFeign to matching RestController routes, Spring `@ConditionalOnProperty` keys, and MyBatis `SqlSessionTemplate` statement IDs to namespace-qualified XML mappings. These links come from parseable literals and declarations; SolidKG doesn't execute framework runtimes or guess dynamic paths.

## Dynamic-dispatch coverage

Static parsing misses computed and indirect calls, so flows can break at dynamic dispatch. SolidKG bridges several boundaries with synthesizers so common flows connect end-to-end:

- Callback and observer registration
- `EventEmitter` channels
- React re-render (`setState` to `render`)
- JSX child (`render` to child component)
- Django ORM descriptors
- Swift and Objective-C bridging
- React Native native modules, events, and view components
- Expo modules
- SCIP implementation and type-contract relationships

Every synthesized edge is marked `provenance: 'heuristic'` with the site that wired it, and is shown inline wherever a path crosses it.