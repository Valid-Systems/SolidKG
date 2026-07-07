# Nix Flake Packaging Boundary

SolidKG has two separate Nix-related surfaces:

1. `.nix` language indexing, which parses Nix source files into the local graph.
2. Nix flake packaging, which is a distribution wrapper around an already-built SolidKG release.

The first surface is implemented by the Nix extractor. It records static bindings, named functions, path imports, `import <nixpkgs>`-style imports, function applications, and variable references. It does not run Nix, evaluate flakes, instantiate derivations, resolve overlays, or interpret module options.

The second surface must not replace the official release workflow. SolidKG releases are still prepared and published by GitHub Actions: `scripts/build-bundle.sh`, GitHub Release assets, and the npm shim/per-platform packages remain the source of truth.

A downstream flake may package SolidKG by fetching a published release bundle or npm package and exposing the bundled `solidkg` binary. A flake should not:

- bump SolidKG versions;
- publish npm packages;
- create Git tags or GitHub Releases;
- rebuild or replace the official release bundle matrix;
- execute Terraform or Nix during SolidKG indexing.

This keeps Nix packaging useful for Nix users while preserving the existing cross-platform release process.
