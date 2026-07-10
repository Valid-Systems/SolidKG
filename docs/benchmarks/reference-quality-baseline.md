# SolidKG Reference Quality Baseline

> Diagnostic reference-index snapshot. This is not a current-build extraction or universal superiority claim.

Generated: 2026-07-10T03:13:09.717Z

Indexes: 52 discovered; 51 measured.

## Aggregate coverage

| Metric | Numerator | Denominator | Micro | Repo median |
|---|---:|---:|---:|---:|
| Any cross-file dependent | 31143 | 93784 | 33.2% | 42.2% |
| Semantic cross-file dependent | 28319 | 93784 | 30.2% | 39.5% |

## Independent metric lanes

| Lane | Numerator | Denominator | Micro | Repo median |
|---|---:|---:|---:|---:|
| routeLink | 7922 | 12424 | 63.8% | 25.8% |
| routeIntegrity | 7218 | 7923 | 91.1% | 100.0% |
| sourceChunkNode | 95420 | 137352 | 69.5% | 50.0% |
| scipDocument | 6824 | 117482 | 5.8% | 0.0% |
| scipLinkedNode | 25506 | 1122980 | 2.3% | 0.0% |
| capabilityComplete | 85963 | 117482 | 73.2% | 87.6% |

## Language coverage

| Language | Any micro | Any median | Semantic micro | Semantic median |
|---|---:|---:|---:|---:|
| astro | 30.1% | 30.1% | 30.1% | 30.1% |
| bash | 12.1% | 5.6% | 11.3% | 4.6% |
| c | 62.0% | 57.7% | 57.4% | 41.6% |
| cpp | 66.3% | 60.0% | 47.6% | 51.8% |
| csharp | 15.0% | 48.5% | 15.0% | 48.5% |
| dart | 30.1% | 30.1% | 29.1% | 29.1% |
| fortran | 42.1% | 42.1% | 42.1% | 42.1% |
| go | 52.7% | 53.0% | 52.7% | 53.0% |
| hcl | 4.7% | 4.3% | 4.7% | 4.3% |
| java | 0.0% | 0.0% | 0.0% | 0.0% |
| javascript | 17.6% | 22.4% | 10.3% | 15.9% |
| jinja | 30.3% | 28.6% | 30.3% | 28.6% |
| jsx | 35.8% | 18.3% | 18.5% | 1.4% |
| julia | 52.6% | 52.6% | 52.6% | 52.6% |
| kotlin | 48.6% | 48.6% | 48.6% | 48.6% |
| liquid | 33.3% | 17.4% | 33.3% | 17.4% |
| lua | 17.7% | 33.6% | 17.7% | 33.6% |
| luau | 24.2% | 24.2% | 24.2% | 24.2% |
| nix | 0.0% | 0.0% | 0.0% | 0.0% |
| objc | 44.3% | 37.5% | 36.8% | 37.5% |
| php | 46.3% | 45.9% | 46.3% | 45.9% |
| powershell | 10.8% | 0.0% | 10.8% | 0.0% |
| python | 32.1% | 31.1% | 32.0% | 31.0% |
| razor | 0.0% | 0.0% | 0.0% | 0.0% |
| ruby | 44.2% | 46.9% | 43.8% | 46.9% |
| rust | 48.7% | 49.2% | 48.4% | 48.8% |
| solidity | 3.7% | 3.7% | 3.4% | 3.4% |
| sql | 20.8% | 20.0% | 20.8% | 20.0% |
| svelte | 94.4% | 100.0% | 44.4% | 41.7% |
| swift | 45.9% | 42.9% | 45.7% | 42.9% |
| tsx | 23.9% | 77.6% | 12.6% | 65.3% |
| typescript | 48.3% | 47.9% | 30.1% | 31.7% |
| vue | 12.5% | 100.0% | 11.5% | 50.0% |
| yaml | 0.0% | 0.0% | 0.0% | 0.0% |

## Availability and health

- No-declaration exclusions: 23698
- File errors: 0
- Dangling edges: 0
- Duplicate canonical repositories: 0
- Schema versions: {"9":50,"10":2}
- Producer versions: {"0.8.0":52}

### Optional feature availability

- capabilityAssertions: {"available_empty":12,"available_nonempty":40}
- capabilityRuns: {"available_empty":1,"available_nonempty":51}
- hyperedgeMembers: {"available_empty":23,"available_nonempty":29}
- hyperedges: {"available_empty":23,"available_nonempty":29}
- scipDocuments: {"available_empty":31,"available_nonempty":21}
- scipNodeLinks: {"available_empty":33,"available_nonempty":19}
- sourceChunks: {"absent":50,"available_empty":1,"available_nonempty":1}

## Repository results

| Repository | Status | Schema | Files | Fair any | Fair semantic | Unresolved / 1k |
|---|---|---:|---:|---:|---:|---:|
| angular__angular | measured | 9 | 2230 | 65.6% | 31.5% | 954.772 |
| ansible | measured | 9 | 4317 | 27.9% | 27.6% | 1268.216 |
| ansible__awx | measured | 9 | 1202 | 24.2% | 24.1% | 1585.669 |
| apache__airflow | measured | 10 | 8772 | 41.1% | 39.5% | 1269.147 |
| apple__swift-nio | measured | 9 | 657 | 59.5% | 59.1% | 1903.703 |
| Azure__azure-powershell | measured | 10 | 6029 | 0.0% | 0.0% | 3873.414 |
| BurntSushi__ripgrep | measured | 9 | 104 | 57.3% | 57.3% | 2489.784 |
| dart-lang__pub | measured | 9 | 509 | 30.1% | 29.1% | 5607.579 |
| dbt-labs__dbt-core | measured | 9 | 770 | 32.7% | 32.7% | 833.59 |
| django__django | measured | 9 | 3331 | 34.4% | 34.1% | 1511.751 |
| electron__electron | measured | 9 | 1831 | 51.0% | 30.5% | 3064.976 |
| etcd-io__etcd | measured | 9 | 1139 | 48.3% | 48.2% | 2746.304 |
| ethereum__solidity | measured | 9 | 8422 | 10.6% | 8.5% | 1506.659 |
| facebook__react | measured | 9 | 591 | 52.3% | 43.0% | 1171.415 |
| hashicorp__consul | measured | 9 | 2909 | 52.2% | 52.2% | 2904.958 |
| hashicorp__nomad | measured | 9 | 3499 | 39.4% | 38.7% | 3210.251 |
| hashicorp__terraform | measured | 9 | 4167 | 31.0% | 31.0% | 3651.455 |
| hashicorp__vault | measured | 9 | 4911 | 42.2% | 41.4% | 2238.834 |
| Homebrew__brew | measured | 9 | 1778 | 47.6% | 47.6% | 1751.254 |
| jekyll__jekyll | measured | 9 | 285 | 52.9% | 52.2% | 1631.86 |
| julia | measured | 9 | 1210 | 54.7% | 54.1% | 1024.747 |
| JuliaLang__julia | measured | 9 | 1200 | 54.8% | 54.3% | 1024.628 |
| laravel__framework | measured | 9 | 2797 | 53.4% | 53.4% | 2800.297 |
| mastodon__mastodon | measured | 9 | 4603 | 46.7% | 41.8% | 1548.231 |
| moby__moby | measured | 9 | 2219 | 48.9% | 48.9% | 3034.354 |
| numpy__numpy | measured | 9 | 1082 | 43.2% | 40.9% | 2823.911 |
| nuxt__nuxt | measured | 9 | 607 | 9.6% | 9.0% | 875.652 |
| OrchardCMS__OrchardCore | empty | 9 | 0 | n/a | n/a | n/a |
| pallets__flask | measured | 9 | 107 | 45.5% | 44.3% | 683.495 |
| pallets__jinja | measured | 9 | 68 | 42.4% | 40.7% | 935.629 |
| pandas-dev__pandas | measured | 9 | 1664 | 26.3% | 26.0% | 3103.708 |
| pointfreeco__swift-composable-architecture | measured | 9 | 798 | 26.2% | 26.2% | 2135.181 |
| PowerShell__PowerShell | measured | 9 | 1932 | 60.7% | 60.7% | 1003.721 |
| prometheus | measured | 9 | 1334 | 62.6% | 57.1% | 3879.25 |
| rails__rails | measured | 9 | 3674 | 50.2% | 49.9% | 2239.375 |
| Roblox__luau | measured | 9 | 847 | 55.3% | 49.0% | 5489.268 |
| rust-lang__cargo | measured | 9 | 1198 | 26.0% | 25.9% | 7379.831 |
| saltstack__salt | measured | 9 | 3002 | 24.3% | 24.3% | 2001.976 |
| scikit-learn__scikit-learn | measured | 9 | 1072 | 40.6% | 40.6% | 2614.126 |
| serde-rs__serde | measured | 9 | 208 | 20.9% | 20.9% | 2145.5 |
| Shopify__dawn | measured | 9 | 126 | 37.4% | 37.4% | 2348.446 |
| Shopify__liquid | measured | 9 | 194 | 32.9% | 32.9% | 2070.831 |
| sveltejs__kit | measured | 9 | 11 | 20.0% | 0.0% | 1818.182 |
| sveltejs__svelte | measured | 9 | 41 | 34.5% | 17.2% | 2225.49 |
| swiftlang__swift-package-manager | measured | 9 | 1733 | 49.6% | 49.1% | 2456.283 |
| tauri-apps__tauri | measured | 9 | 474 | 50.9% | 48.6% | 3818.808 |
| terraform | measured | 9 | 4245 | 31.0% | 31.0% | 3634.844 |
| tokio-rs__tokio | measured | 9 | 775 | 46.8% | 46.6% | 3145.385 |
| vercel__next.js | measured | 9 | 18743 | 18.8% | 9.6% | 1478.639 |
| vuejs__core | measured | 9 | 70 | 47.9% | 41.7% | 2825.301 |
| withastro__astro | measured | 9 | 235 | 30.4% | 27.3% | 1505.198 |
| WordPress__wordpress-develop | measured | 9 | 3760 | 36.1% | 36.0% | 2484.602 |

## Status distribution

- empty: 1
- measured: 51

## Probe diagnostics

| Probe | Status | Repeats | p50 ms | Payload bytes | Expectation misses |
|---|---|---:|---:|---:|---:|
| apache__airflow/airflow-dagbag-context | measured | 5 | 6666.946 | 3514 | 0 |
| Azure__azure-powershell/azure-rest-method-context | measured | 5 | 2069.225 | 2701 | 0 |

## Claim boundary

Diagnostic reference-index snapshot. Mixed historical indexes do not prove current-build extraction quality or universal superiority.
