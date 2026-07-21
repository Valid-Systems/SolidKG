# Codebase evidence inventory

This inventory separates repositories with recorded benchmark, playbook, or reference-quality evidence from directories that were merely present in an external snapshot. Presence alone is not validation or stress-test evidence.

```text
D:\Apps\Programming_Tools\tmp\solidkg_reference_codebases\repos
```

Directory names with `__` encode `owner/repo`. Single-name directories are local checkout names for the upstream project. The external snapshot contained 118 repository directories on 2026-07-10; batch/log files in that folder are intentionally excluded.

The reference-quality baseline found 52 indexes: 51 measurable and one empty. Only those 51 rows, plus repositories named in benchmark or playbook records, carry recorded evidence. The other directory names below are availability records only. Static-analysis measurement is not a runtime guarantee.

## Benchmark and playbook suites

These are the repos explicitly called out in the current benchmark and dynamic-dispatch validation docs:

- VS Code
- Excalidraw
- Django
- Tokio
- OkHttp
- Gin
- Alamofire
- Redis
- aspnet-realworld
- aspnet-eshop / eShopOnWeb
- aspnet-jellyfin / Jellyfin
- LevelDB
- flutter_module_books
- compass_app
- gin-realworld
- gin-vue-admin
- gitness
- spring-realworld
- spring-mall
- spring-halo
- kotlin-petclinic
- Jetcaster
- lualine.nvim
- telescope.nvim
- Roblox Knit
- laravel-realworld
- laravel-firefly
- laravel-bookstack
- django-realworld
- django-wagtail
- django-saleor
- rails-realworld
- rails-spree
- rails-forem
- rust-axum-realworld
- rust-actix-examples
- rust-cratesio / crates.io
- computer-database
- vapor-template
- vapor-steampress / SteamPress
- vapor-spi / SwiftPackageIndex-Server
- express-realworld
- nest-immich / Immich
- vitepress
- vben
- element-plus
- skeleton
- shadcn Svelte
- Ghost
- amplication
- fastapi-realworld
- flask-microblog
- Netflix dispatch
- redash
- Rocket
- petclinic-kotlin
- admin_toolbar
- webform
- drupal-core
- Charts
- realm-swift
- wikipedia-ios
- AsyncStorage
- react-native-firebase
- RNGeolocation
- expo-haptics
- expo-camera
- Expo SDK sweep
- RNSegmentedControl
- RNScreens
- RNSkia

## Local large-reference snapshot suite

All repository directories below were present in the external snapshot. Unless a repository also appears in a benchmark, playbook, or the 51-row measurable baseline, its listing does not claim it was indexed or tested:

| Local directory                              | Project                                   |
| -------------------------------------------- | ----------------------------------------- |
| `angular__angular`                           | angular/angular                           |
| `ansible__awx`                               | ansible/awx                               |
| `ansible`                                    | Ansible                                   |
| `apache__airflow`                            | apache/airflow                            |
| `apache__camel`                              | apache/camel                              |
| `apache__kafka`                              | apache/kafka                              |
| `apache__lucene`                             | apache/lucene                             |
| `apache__spark`                              | apache/spark                              |
| `apple__swift-nio`                           | apple/swift-nio                           |
| `Azure__azure-powershell`                    | Azure/azure-powershell                    |
| `BurntSushi__ripgrep`                        | BurntSushi/ripgrep                        |
| `ceph`                                       | Ceph                                      |
| `clickhouse`                                 | ClickHouse                                |
| `cockroach`                                  | CockroachDB                               |
| `cpython`                                    | CPython                                   |
| `dart-lang__pub`                             | dart-lang/pub                             |
| `dart-lang__sdk`                             | dart-lang/sdk                             |
| `dbt-labs__dbt-core`                         | dbt-labs/dbt-core                         |
| `denoland__deno`                             | denoland/deno                             |
| `discourse__discourse`                       | discourse/discourse                       |
| `django__django`                             | django/django                             |
| `dotnet__aspnetcore`                         | dotnet/aspnetcore                         |
| `dotnet__roslyn`                             | dotnet/roslyn                             |
| `dotnet__runtime`                            | dotnet/runtime                            |
| `dotnet__winforms`                           | dotnet/winforms                           |
| `dotnet__wpf`                                | dotnet/wpf                                |
| `drupal__drupal`                             | drupal/drupal                             |
| `elastic__elasticsearch`                     | elastic/elasticsearch                     |
| `elastic__kibana`                            | elastic/kibana                            |
| `electron__electron`                         | electron/electron                         |
| `envoy`                                      | Envoy                                     |
| `etcd-io__etcd`                              | etcd-io/etcd                              |
| `ethereum__solidity`                         | ethereum/solidity                         |
| `facebook__react`                            | facebook/react                            |
| `flink`                                      | Apache Flink                              |
| `flutter__flutter`                           | flutter/flutter                           |
| `fpc__FPCSource`                             | fpc/FPCSource                             |
| `fpc__Lazarus`                               | fpc/Lazarus                               |
| `gcc`                                        | GCC                                       |
| `gemini-cli`                                 | Gemini CLI                                |
| `go`                                         | Go                                        |
| `gradle__gradle`                             | gradle/gradle                             |
| `grafana`                                    | Grafana                                   |
| `hashicorp__consul`                          | hashicorp/consul                          |
| `hashicorp__nomad`                           | hashicorp/nomad                           |
| `hashicorp__terraform-provider-aws`          | hashicorp/terraform-provider-aws          |
| `hashicorp__terraform`                       | hashicorp/terraform                       |
| `hashicorp__vault`                           | hashicorp/vault                           |
| `Homebrew__brew`                             | Homebrew/brew                             |
| `jdk`                                        | OpenJDK JDK                               |
| `jekyll__jekyll`                             | jekyll/jekyll                             |
| `JetBrains__intellij-community`              | JetBrains/intellij-community              |
| `JetBrains__kotlin`                          | JetBrains/kotlin                          |
| `julia`                                      | Julia                                     |
| `JuliaLang__julia`                           | JuliaLang/julia                           |
| `kotlin`                                     | Kotlin                                    |
| `kubernetes__kubernetes`                     | kubernetes/kubernetes                     |
| `kubernetes__website`                        | kubernetes/website                        |
| `laravel__framework`                         | laravel/framework                         |
| `llvm-project`                               | LLVM Project                              |
| `lowRISC__opentitan`                         | lowRISC/opentitan                         |
| `magento__magento2`                          | magento/magento2                          |
| `mastodon__mastodon`                         | mastodon/mastodon                         |
| `mattermost__mattermost`                     | mattermost/mattermost                     |
| `microsoft__azure-pipelines-tasks`           | microsoft/azure-pipelines-tasks           |
| `microsoft__TypeScript`                      | microsoft/TypeScript                      |
| `microsoft__vscode`                          | microsoft/vscode                          |
| `moby__moby`                                 | moby/moby                                 |
| `mono__mono`                                 | mono/mono                                 |
| `neovim__neovim`                             | neovim/neovim                             |
| `NixOS__nixpkgs`                             | NixOS/nixpkgs                             |
| `nixpkgs`                                    | nixpkgs                                   |
| `node`                                       | Node.js                                   |
| `numpy__numpy`                               | numpy/numpy                               |
| `nuxt__nuxt`                                 | nuxt/nuxt                                 |
| `openharmony__arkui_ace_engine`              | OpenHarmony arkui_ace_engine              |
| `OrchardCMS__OrchardCore`                    | OrchardCMS/OrchardCore                    |
| `oven-sh__bun`                               | oven-sh/bun                               |
| `pallets__flask`                             | pallets/flask                             |
| `pallets__jinja`                             | pallets/jinja                             |
| `pandas-dev__pandas`                         | pandas-dev/pandas                         |
| `perl`                                       | Perl                                      |
| `php-src`                                    | PHP source                                |
| `phpmyadmin__phpmyadmin`                     | phpmyadmin/phpmyadmin                     |
| `pointfreeco__swift-composable-architecture` | pointfreeco/swift-composable-architecture |
| `PowerShell__PowerShell`                     | PowerShell/PowerShell                     |
| `prometheus`                                 | Prometheus                                |
| `pytorch__pytorch`                           | pytorch/pytorch                           |
| `rails__rails`                               | rails/rails                               |
| `ray-project__ray`                           | ray-project/ray                           |
| `ray`                                        | Ray                                       |
| `react-native`                               | React Native                              |
| `Roblox__luau`                               | Roblox/luau                               |
| `ruby_ruby`                                  | ruby/ruby                                 |
| `rust-lang__cargo`                           | rust-lang/cargo                           |
| `rustlang_rust`                              | rust-lang/rust                            |
| `saltstack__salt`                            | saltstack/salt                            |
| `scikit-learn__scikit-learn`                 | scikit-learn/scikit-learn                 |
| `serde-rs__serde`                            | serde-rs/serde                            |
| `Shopify__dawn`                              | Shopify/dawn                              |
| `Shopify__liquid`                            | Shopify/liquid                            |
| `shopware__shopware`                         | shopware/shopware                         |
| `spring-projects__spring-framework`          | spring-projects/spring-framework          |
| `sveltejs__kit`                              | sveltejs/kit                              |
| `sveltejs__svelte`                           | sveltejs/svelte                           |
| `swiftlang__swift-package-manager`           | swiftlang/swift-package-manager           |
| `swiftlang_swift`                            | swiftlang/swift                           |
| `symfony__symfony`                           | symfony/symfony                           |
| `tauri-apps__tauri`                          | tauri-apps/tauri                          |
| `tensorflow__tensorflow`                     | tensorflow/tensorflow                     |
| `terraform`                                  | Terraform                                 |
| `tokio-rs__tokio`                            | tokio-rs/tokio                            |
| `TypeScript`                                 | TypeScript                                |
| `v8`                                         | V8                                        |
| `vercel__next.js`                            | vercel/next.js                            |
| `vuejs__core`                                | vuejs/core                                |
| `withastro__astro`                           | withastro/astro                           |
| `WordPress__wordpress-develop`               | WordPress/wordpress-develop               |
