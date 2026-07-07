---
title: Languages
description: Every language SolidKG parses, and the extensions it recognizes.
---

Language support is automatic from the file extension, so there's nothing to configure. Contributors adding a new language should follow [Add a Language](/solidkg/guides/add-language/) before updating this table.

| Language | Extensions | Status |
|---|---|---|
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | Full support |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | Full support |
| Python | `.py` | Full support |
| Go | `.go` | Full support |
| Rust | `.rs` | Full support |
| Java | `.java` | Full support |
| C# | `.cs` | Full support |
| PHP | `.php` | Full support |
| Ruby | `.rb` | Full support |
| C | `.c`, `.h` | Full support |
| C++ | `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hxx`, `.cu`, `.cuh` | Full support for C++ syntax; CUDA files are mapped through the C++ parser without CUDA kernel-launch semantics |
| Swift | `.swift` | Full support |
| Kotlin | `.kt`, `.kts` | Full support |
| Groovy | `.groovy`, `.gradle`, `.gvy`, `.gy`, `.gsh` | Static source support for classes, methods, closure-valued declarations, imports, calls, and simple Gradle task declarations; no Grails/Gradle runtime semantics |
| Visual Basic .NET | `.vb` | VB.NET support for modules, classes, methods/functions, properties, imports, and fields; VBA/VB6 are not covered |
| Scala | `.scala`, `.sc` | Full support (classes, traits, methods, type aliases, Scala 3 enums) |
| Dart | `.dart` | Full support |
| Svelte | `.svelte` | Full support (script extraction, Svelte 5 runes, SvelteKit routes) |
| Vue | `.vue` | Full support (script + script-setup, Nuxt page/API/middleware routes) |
| Astro | `.astro` | Hybrid support for frontmatter, inline scripts, and static component tags; no runtime template execution |
| Liquid | `.liquid` | Full support |
| Jinja2 / HTML templates | `.html`, `.jinja`, `.jinja2` | Static support for file nodes, `{% block %}` sections, and include/extends/import references |
| Razor | `.cshtml` | Static support for `@model`, partial references, and parseable C# code blocks; no Razor runtime execution |
| Pascal / Delphi / Lazarus | `.pas`, `.dpr`, `.dpk`, `.lpr`, `.dfm`, `.fmx`, `.lfm`, `.lpi` | Full support for Pascal source and DFM/FMX/LFM forms; `.lpi` project files are file-level records |
| YAML | `.yml`, `.yaml` | File-level tracking; framework resolvers may add routes or references |
| Twig | `.twig` | File-level tracking |
| Lua | `.lua` | Full support (functions, methods, locals, `require` imports, call edges) |
| Luau | `.luau` | Full support (Lua, plus typed signatures, `type` aliases, Roblox `require`) |
| Verilog / SystemVerilog | `.v`, `.vh`, `.sv`, `.svh` | Static support for modules, classes, constructors, functions/tasks, enum typedefs, package imports, fields, and direct calls; no simulator/elaboration semantics |
| Julia | `.jl` | Static support for modules, structs, functions, macros, imports/using, assignments, and direct calls; no package loading, macro expansion, or runtime dispatch |
| Fortran | `.f`, `.for`, `.f90`, `.f95`, `.f03`, `.f08` | Static support for modules, derived types, functions/subroutines, `use` imports, fields, variables, and direct calls; no compiler or preprocessing execution |
| R | `.r` / `.R` | Static support for function assignments, R6 class declarations, fields, `library`/`require`/`source` imports, variables, and direct calls; no package loading or non-standard evaluation |
| HCL / Terraform | `.tf`, `.hcl` | Static support (blocks, module sources, locals, references, function calls); no plan/provider/module evaluation |
| Nix | `.nix` | Static support (bindings, named functions, imports, references); no derivation, flake, overlay, or module evaluation |
| Bash / sh | `.sh`, `.bash`, `.bats` | Static support (functions, sourced files, simple assignments, command calls; no shell execution or environment expansion) |
| PowerShell | `.ps1`, `.psm1`, `.psd1` | Static support (functions, classes, modules, dot-sourced scripts, command calls; no script execution or profile loading) |
| SQL | `.sql` | Conservative static support (tables, views, functions, CTEs, SELECT queries, relation references, call edges); dbt projects link static `ref()`, `source()`, and macro calls without dialect execution |
| ArkTS | `.ets` | Conservative static support for Harmony-style imports, classes/interfaces, `@Component`/`struct` components, functions, methods, variables, and direct calls |
| PLC SCL | `.scl` | Conservative static support for common PLC block/function declarations, variable sections, and direct call syntax; no PLC runtime/toolchain semantics |
| Solidity | `.sol` | Static source support for contracts, interfaces, libraries, functions, events, modifiers, state variables, inheritance, imports, and statically visible calls; no compiler execution, EVM dispatch modeling, or vulnerability analysis |
