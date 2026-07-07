# Evaluation Corpus Policy

This policy defines the manifest-first approval gate for any vendored or installed evaluation corpus used by SolidKG retrieval, language, framework, or release-readiness checks.

The approved corpus manifest lives at `fixtures/evaluation-corpus/manifest.json`. It is the durable project-local record for corpus approval. Generated evaluation reports, temporary checkout paths, external `EVAL_CODEBASE` runs, and synthetic fixtures are not approved corpus records.

## Current Readiness Status

Task 3 is Step A only. It establishes policy, package guardrails, and an empty approved-real-corpus manifest.

Synthetic fixtures and policy documents do not satisfy vendored-codebase install readiness. Full readiness requires Step B: an approved real-corpus install, build, and smoke workflow after license and source approval, or an explicit maintainer waiver.

## Manifest Requirements

Each real corpus entry must include:

- `name`: stable local identifier for the corpus.
- `sourceUrl`: canonical upstream source URL.
- `revision`: immutable commit SHA, tag, archive digest, or equivalent pinned revision.
- `license`: SPDX identifier or explicit license label captured for deterministic metadata review.
- `purpose`: why this corpus is needed and which evaluation flows it supports.
- `fetchCommand`: explicit command used to fetch or install the corpus.
- `installCommand`: explicit command used to install corpus dependencies, or `none` when no install step is needed.
- `buildCommand`: explicit command used to build the corpus, or `none` when no build step is needed.
- `smokeCommand`: deterministic command proving the corpus can be exercised locally.
- `expectedArtifacts`: paths expected after fetch/install/build/smoke.
- `inclusionPolicy`: release and npm packaging policy for the corpus.
- `cleanupCommand`: explicit command for removing generated corpus state.

The validator rejects entries missing license, revision, build command, smoke command, or inclusion policy. It also rejects missing name, source URL, purpose, fetch/install commands, expected artifacts, or cleanup command so future entries are complete before review.

## Fetch And Install Policy

Corpora are optional. They must be fetched or installed only when explicitly requested by a maintainer, an evaluation command, or a documented local workflow.

Do not clone, vendor, fetch, or add third-party repositories as a side effect of normal install, build, test, package, or release commands. Real corpus additions require explicit source approval and license metadata in the manifest before any code or archive is added.

## Package And Release Inclusion Policy

Default policy: corpus paths are excluded from npm and release artifacts.

Current exclusion anchors:

- Root `package.json` publishes only `dist`, `scripts`, `LICENSE`, `README.md`, and third-party notice files through the `files` allowlist. `fixtures` is not allowlisted.
- `scripts/build-bundle.sh` stages only `dist`, `LICENSE`, `package.json`, `package-lock.json`, production dependencies, and launchers into standalone bundles. It does not copy `fixtures`.
- `scripts/pack-npm.sh` writes platform package `files` arrays containing only the vendored Node binary, `lib`, `bin`, and `LICENSE`; the main shim package contains only `npm-shim.js`, `README.md`, and `LICENSE`.

Before any corpus is included in a package or bundle, package and bundle allowlist documentation must be updated in this policy and covered by tests. A corpus may ship in release artifacts only when its manifest entry sets `inclusionPolicy.shipInRelease` to `true` and includes a non-empty `inclusionPolicy.licenseApproval` value naming the approval record or maintainer approval. This is metadata and release gating only, not legal advice.

## Initial Manifest

The initial manifest intentionally contains schema/version metadata and an empty `corpora: []` array. Adding real vendored repositories is deferred until license/source approval is explicit.


## Synthetic Evaluation Fixtures

Synthetic fixtures may be recorded under `syntheticFixtures` in the manifest when they are small, generated inside tests, and do not fetch or execute real third-party repositories. These entries are useful for deterministic Task 8-style probe linkage, but they are not approved real corpora and do not satisfy vendored-codebase install readiness.


## Non-Executed Future Real-Repo Registration Example

The following example is documentation only. It is not present in `corpora`, must not be fetched by tests or probes, and would require maintainer source and license approval before execution.

```json
{
  "name": "future-approved-framework-corpus",
  "sourceUrl": "https://example.invalid/owner/framework-corpus.git",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "license": "MIT",
  "purpose": "Future real-repo validation after explicit approval; not executable in Task 8.",
  "fetchCommand": "git clone --filter=blob:none https://example.invalid/owner/framework-corpus.git fixtures/evaluation-corpus/approved/future-approved-framework-corpus",
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm run build",
  "smokeCommand": "pnpm test -- --runInBand",
  "expectedArtifacts": ["dist/", ".solidkg/solidkg.db"],
  "inclusionPolicy": {
    "shipInRelease": false,
    "licenseApproval": null
  },
  "cleanupCommand": "rm -rf fixtures/evaluation-corpus/approved/future-approved-framework-corpus"
}
```
