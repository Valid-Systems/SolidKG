# SolidKG-maintained SCIP indexers

This directory contains pinned source copies of SCIP indexers maintained for
SolidKG. They are included in GitHub source archives intentionally.

## Why these copies ship

SolidKG depends on an exact indexer contract: command-line invocation, output
file placement, project-root metadata, symbol encoding, and cross-platform
process behavior must remain compatible with SolidKG's generation, import,
linking, and status paths. These trees are SolidKG compatibility variants and
carry SolidKG-specific changes where official upstream behavior diverges, so a
floating upstream release is not an equivalent replacement even when it has
the same project name.

Keeping the supported source beside SolidKG makes releases reproducible and
auditable. Upstream updates should be ported deliberately, reviewed against the
local changes, and tested through SolidKG before replacing a pinned tree.

The upstream projects remain the original authors and copyright holders. Their
licenses and notices are retained in their respective directories.

| SolidKG source | Original upstream | License | SolidKG integration |
|---|---|---|---|
| `scip-clang/` | `sourcegraph/scip-clang` | Apache-2.0 | Produces importable C/C++ SCIP indexes |
| `scip-dart/` | `Workiva/scip-dart` | Apache-2.0 | Produces importable Dart SCIP indexes |
| `scip-dotnet/` | `sourcegraph/scip-dotnet` | Apache-2.0 | Default `scip-dotnet` generator for C# |
| `scip-java/` | `sourcegraph/scip-java` | Apache-2.0 | Produces importable Java/Kotlin SCIP indexes |
| `scip-php/` | `davidrjenni/scip-php` | MIT | Produces importable PHP SCIP indexes |
| `scip-python/` | `sourcegraph/scip-python` | MIT | Default `scip-python` generator for Python |
| `scip-ruby/` | `sourcegraph/scip-ruby` | Apache-2.0 | Produces importable Ruby SCIP indexes |
| `scip-typescript/` | `sourcegraph/scip-typescript` | Apache-2.0 | Source counterpart of the bundled TypeScript/JavaScript generator |

## Building and using an indexer

`pnpm run build` compiles SolidKG, its parser assets, and the bundled
TypeScript SCIP integration. It deliberately does not install every language
toolchain or compile all repositories in this directory.

For another language:

1. Build the matching pinned tree using its own README and native toolchain.
2. Put the resulting command on `PATH` under the name SolidKG expects (for
   example `scip-python` or `scip-dotnet`).
3. Run `solidkg scip generate --path <project>` and inspect
   `solidkg status <project>` for generated, imported, and linked facts.
4. For indexers that are not automatic generator defaults, create the `.scip`
   file with the maintained tool and run
   `solidkg scip import <file> --path <project>`.

Do not overwrite these directories with upstream HEAD as an installation
repair. If a tree or its license is missing from a source archive, download the
same SolidKG commit again.
