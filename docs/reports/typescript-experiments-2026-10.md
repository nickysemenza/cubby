# TypeScript inference experiments

Base: `60e38eae0cdb10650e63b54d6e43bd36764eb4f6` (current main fetched for this experiment).

At final remote verification, main had advanced to
`de4df5b2465e46568b4fcfed9edd13505c0188d0`. Both experimental branches retain
the measured start-of-task baseline. No latest-main compatibility or performance
claim is made, and no completed measurements were restarted after this change.
Hosted PR validation may include a newer merge context than the local baseline.

The experimental branches retain the complete `apps/web/tsconfig.json` program:
application, tests, tooling, generators and imported workspace sources. No new
`skipLibCheck`, exclusions, casts to `any`, `noCheck`, or missing-dependency stubs.

Environment: Linux x86_64, Intel Xeon Platinum 8370C, 4 CPU cgroup quota, 16 GiB
memory limit, Node 24.19.0, lockfile TypeScript 7.0.2 and Zod 4.6.7. The environment's
pnpm launcher reported 11.19.0 despite the repository's 12.11.2 package-manager
pin; the frozen lockfile was used unchanged for every variant.

Preparation is excluded: dependency installation (87.8s including generation),
Rust/wasm-pack installation, initial WASM compilation and generation. Binaryen's
optimizer download failed. `wasm-pack build --no-opt --no-pack` produced real
worker/browser/cookbook declarations with the checked-in Rust sources and feature
sets; skipping binary optimization does not stub or alter the type boundary.
The strict `loadEntityDeclarationBundle` probe loaded all 29 entities. Generation was
15.5s during baseline installation; later uncached map and combined generation
reported 16.0s and 15.2s respectively through Nx (setup wall time, not compiler
CPU measurements).

Compiler command: `node node_modules/typescript/bin/tsc --noEmit --checkers 1 -p apps/web/tsconfig.json --extendedDiagnostics`.
No other compiler, build, test suite or benchmark ran concurrently. Wall time uses
Python monotonic time; CPU and peak RSS use `wait4` for the compiler child. Node
24 execs the native tsc binary, so these cover the compiler rather than a pnpm/Nx
wrapper. RSS is the process high-water mark, not summed sampled RSS. OS filesystem
cache stays warm; “cold” means no TypeScript buildinfo.

Each repeat starts with a cold check, saves that exact revision's buildinfo, then
runs unchanged warm. Every edit independently restores that same pristine
buildinfo. The body edit adds `+ 0` to `Math.abs(price)` in `unit-price-format.ts`;
the export edit adds an exported synthetic type in that module; the shared-schema
edit adds a description to `devicePlatform` in `device-fields.ts`. Source files
are restored after each probe. No buildinfo is copied across variants or commits.
Generation happens before compiler timing, and these probes do not require
regeneration: neither schema shape nor declaration metadata changes.

Baseline correctness limitation: six TS2353 diagnostics already occur in
`apps/web/tests/e2e/http-entity-kernel-api.spec.ts` at lines 208, 218, 232, 240,
249, 257 (flat `action`/`entity` arguments versus `{ input: unknown }`). These runs
are **not passing full typechecks**. The harness requires each experimental run
to retain exactly the same diagnostics, and stops on additions/removals. Focused
schema contracts and app-only validation are reported separately.

## Options

- Requested label-path validation: expand only roots matching requested paths,
  retaining the original recursive path grammar. The previous conditional type first enumerated every
  possible nested path across its readable schemas. Runtime code and inferred
  entity/schema types remain unchanged.
- Generated field-schema contracts: annotate generated maps with named
  interfaces, field keys, and exact declaration-tuple Zod schema types. Runtime `fieldSchemasOf`
  continues key-based lookup, so declaration reordering cannot silently bind the
  wrong field. No widening to `ZodType<Output>` loses input types, schema methods,
  transforms or brands. Synthesized data-quality fields retain their existing
  composition. Separate generated compiler-only roots prove bidirectional
  assignability of every create/update/read map against `FieldSchemas<typeof
  definition>`; Knip recognizes those roots. Their producer cost is included in
  the standalone schema measurements. These are exact schema-class contracts,
  not plain recursive value interfaces or a declaration/project-reference
  boundary: implementation imports remain reachable.
- Combination: both independent changes applied to the identical baseline.

## Patterns considered

[TypeScript performance guidance](https://github.com/microsoft/TypeScript/wiki/Performance)
recommends named annotations and measuring project boundaries. The
[project-reference handbook](https://www.typescriptlang.org/docs/handbook/project-references.html)
requires declaration boundaries; [TypeScript 5.9.3's source solution](https://github.com/microsoft/TypeScript/blob/v5.9.3/src/tsconfig.json)
uses an empty root with explicit references. This is a useful graph pattern, not
evidence that merely adding configs improves Cubby.

[Zod's package configuration](https://github.com/colinhacks/zod/blob/main/packages/zod/tsconfig.json)
and [TanStack Router's package configuration](https://github.com/TanStack/router/blob/main/packages/react-router/tsconfig.json)
keep package source/tests under dedicated programs. Cubby's web program also
contains generator code importing schema implementation by relative paths;
redirecting only package exports to declarations would leave those implementations
reachable and can duplicate graphs. A successful split must establish a genuine
router-free leaf and count producer plus consumer cost.

Cubby already generates `FileRoutesByFullPath`, `FileRoutesByTo` and
`_addFileTypes`, and its shared detail-prefetch helper already returns
`Promise<void>`. [TanStack's type-safety guide](https://tanstack.com/router/latest/docs/guide/type-safety)
and [performance discussion](https://tanstack.com/blog/tanstack-router-typescript-performance)
support narrow consumers, but warn that generated maps need not improve total
whole-program work. Regenerating those existing maps was not an experiment.

The [historical Cubby report](https://github.com/nickysemenza/cubby/blob/18f8bd430/docs/reports/local-check-performance.md)
measured whole-web declaration emission at roughly twice the CPU and 8.1 GiB,
not a small schema-only reference boundary. This experiment does not repeat that
whole-program emit. It also avoids low Go memory caps and stale buildinfo copying,
both previously measured as regressions. Root Nx cache output restoration remains
a distinct opportunity; it cannot be claimed as a cold-compiler improvement.

Independent drafts: [requested label roots, #2482](https://github.com/nickysemenza/cubby/pull/2482) and [exact schema-map contracts, #2487](https://github.com/nickysemenza/cubby/pull/2487). Both target the same main baseline. The combined case applies both patches temporarily; neither PR depends on the other and nothing was merged.

## Conclusion and correctness

Neither independent experiment demonstrates a repeatable full-web speedup.
The label variant barely reduces full-web compiler work and does not improve
controlled cold standalone-schema checks. The map variant's two cold runs trade
lower observed peak RSS for higher CPU; its imported type graph remains almost
identical. These drafts are evidence, not recommendations to merge for speed.
The combination also shows no convincing speedup: cold web checks are 101.00–127.52s and 170.25–220.52 CPU seconds, with lower cold peak RSS (6.45–6.46 GiB) but no consistent memory benefit across edits. Full-web instantiations fall only 0.079%.

An early incremental schema probe showed a larger type-count reduction, but was
not cold-to-cold; it is excluded from conclusions. The 08:06 UTC environment
disconnect notification coincided with the final map shared-schema run. At 08:07
the environment was responsive, the run had finished, its source probes were
restored, and all measurements were intact. That timing is retained and flagged
as noisy; it was not silently replaced or restarted.

The expanded label contracts pass on baseline and candidate: nullable array
members, indexed arrays, string brands, transforms to strings, and rejection of
missing keys and numeric outputs. Map contracts pass bidirectional type checks
for every generated map. Focused tests retain schema identity, default input vs
output optionality, string transformations, branded outputs, declared keys,
object `pick`/`partial`, and enum `exclude`. The existing all-entity omitted-update
regression also passes (2 test files / 2 runtime cases, 1.98s total Vitest time).
The final combined schema check also passes with both expanded contract-test
sets present. Full-web runs retain exactly the six inherited diagnostics listed above; no
errors are suppressed in production code. No existing source/test coverage or
required checking command was removed. New contract tests were checked outside
the timing matrix so the baseline workload was identical across variants.
The generated compiler proofs are part of the map variant's schema workload.

Both code commits' hosted Validation jobs reported success: #2482 at
`6ce4a1069` and #2487 at `bbdeb5b26`, including TypeScript and unused-code
checks (the latter was also confirmed from #2487's job-step metadata). Its detailed log download was denied with HTTP 403, so the command/cache
path could not be reconciled with local baseline errors. Existing GitHub
integration access also denied Issue Project metadata. No access scopes or
credentials were expanded. Binaryen download failure was resolved for this
compiler experiment by generating genuine WASM declarations with `--no-opt`;
optimized WASM runtime/build validation is not claimed. Scoped Knip could not
start: loading its configuration invoked the normal WASM prerequisite, which
failed downloading Binaryen version 117. Its new compiler-root entry pattern is
therefore locally unverified; #2487's hosted unused-code step reports success.

These measurements cover the complete web program and the affected schema
program, not total `pnpm typecheck` orchestration across every workspace package.
No plain recursive value-contract boundary or genuine project-reference split
was completed. The exact-schema interface experiment intentionally preserves
all Zod APIs, but still reaches declaration implementations. A future boundary
experiment must remove those source edges and measure producer plus consumer
CPU, not just a smaller consumer. Do not infer a whole-repository speedup from
these local annotations or repeat the failed whole-web declaration emit.

The reproducible [Linux harness](../../scripts/benchmark-typecheck.py) and
[raw measurements](typescript-experiments-2026-10.csv) preserve exit codes and
compiler counters. Run the harness first with `baseline`, then each variant name
in the same prepared checkout. For standalone schemas, first run `baseline
--project packages/schemas/tsconfig.json --cold-only`, then each candidate with
those same flags. Baseline error expectations are recorded separately per
program. Reports retain all samples; no outliers are removed.

Deleted/replaced: the label variant replaces two eager validation type aliases;
the map variant replaces inferred generated map declarations with explicit
contracts. No runtime logic, schema validators, tests or compiler coverage was
deleted. Generated artifacts and screenshots are not committed.

## Measurements

Ranges below contain both measured runs; smaller differences than the baseline spread are inconclusive. CPU is user plus system time.

| Variant          | Scenario |  Wall seconds |   CPU seconds | Peak RSS GiB |
| ---------------- | -------- | ------------: | ------------: | -----------: |
| baseline         | cold     |   92.69–98.91 | 152.71–157.50 |    6.93–7.06 |
| baseline         | warm     |     6.11–7.84 |   22.26–28.55 |    1.59–1.66 |
| baseline         | body     |   89.94–93.09 | 151.58–155.40 |    6.50–6.98 |
| baseline         | export   |  89.44–163.60 | 161.88–271.74 |    6.69–7.14 |
| baseline         | schema   |   89.54–99.65 | 147.01–164.25 |    7.13–7.17 |
| labels           | cold     |   93.37–96.47 | 156.22–162.32 |    6.45–7.10 |
| labels           | warm     |     6.59–7.28 |   23.61–26.69 |    1.60–1.61 |
| labels           | body     |   97.86–98.45 | 166.72–172.27 |    6.49–7.02 |
| labels           | export   |  94.69–104.54 | 164.99–195.65 |    6.48–7.13 |
| labels           | schema   | 104.71–118.70 | 192.37–198.42 |    6.68–6.89 |
| baseline-schemas | cold     |     8.20–8.33 |   14.31–14.70 |    0.82–0.82 |
| baseline-schemas | warm     |     0.52–0.53 |     1.90–1.93 |    0.16–0.16 |
| labels-schemas   | cold     |     8.02–9.74 |   14.30–17.53 |    0.81–0.82 |
| labels-schemas   | warm     |     0.53–0.73 |     1.96–2.63 |    0.16–0.17 |
| maps             | cold     | 109.76–116.72 | 184.57–193.19 |    6.45–6.52 |
| maps             | warm     |     7.21–7.42 |   25.73–26.81 |    1.58–1.65 |
| maps             | body     | 102.86–109.34 | 180.53–184.82 |    6.67–6.79 |
| maps             | export   | 105.80–106.06 | 167.68–178.61 |    6.64–7.15 |
| maps             | schema   | 100.88–108.86 | 169.80–219.53 |    6.98–7.08 |
| maps-schemas     | cold     |     7.96–8.22 |   14.06–14.58 |    0.82–0.84 |
| maps-schemas     | warm     |     0.51–0.53 |     1.84–1.84 |    0.16–0.16 |
| combined         | cold     | 101.00–127.52 | 170.25–220.52 |    6.45–6.46 |
| combined         | warm     |    8.16–11.54 |   28.99–40.36 |    1.61–1.64 |
| combined         | body     |  98.41–137.33 | 167.04–208.74 |    7.08–7.16 |
| combined         | export   |   90.30–96.77 | 154.61–166.50 |    6.57–7.10 |
| combined         | schema   |  91.87–103.42 | 155.08–189.51 |    7.11–7.14 |
| combined-schemas | cold     |     7.83–8.29 |   13.03–14.97 |    0.84–0.86 |
| combined-schemas | warm     |     0.54–0.58 |     1.92–2.04 |    0.16–0.17 |

Cold compiler work (repeat counts agree unless stated):

| Variant          | Files |   Types | Instantiations |
| ---------------- | ----: | ------: | -------------: |
| baseline         | 10694 | 3942894 |       23772076 |
| labels           | 10694 | 3941692 |       23770348 |
| baseline-schemas |   561 |  448815 |        1493981 |
| labels-schemas   |   561 |  447370 |        1486058 |
| maps             | 10694 | 3942898 |       23755068 |
| maps-schemas     |   590 |  449837 |        1499146 |
| combined         | 10694 | 3941696 |       23753340 |
| combined-schemas |   590 |  448392 |        1491223 |

Cold web plus schema CPU (arithmetic sum, excluding setup, orchestration and other packages):

| Variant  | CPU seconds, two runs |
| -------- | --------------------: |
| baseline |        167.01, 172.20 |
| labels   |        170.52, 179.85 |
| maps     |        207.78, 198.62 |
| combined |        183.28, 235.50 |
