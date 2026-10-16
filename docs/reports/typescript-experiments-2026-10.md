# TypeScript inference experiments

Base: `60e38eae0cdb10650e63b54d6e43bd36764eb4f6` (current main fetched for this experiment).

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
The strict `loadEntityDeclarationBundle` probe loaded all 29 entities.

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

- Requested label-path validation: expand only root fields matching the label paths a declaration
  actually requests, retaining the existing recursive path semantics. The previous conditional type first enumerated every
  possible nested path across its readable schemas. Runtime code and inferred
  entity/schema types remain unchanged.
- Generated field-schema contracts: annotate generated maps with named field
  keys and exact declaration-owned Zod schema types. Runtime `fieldSchemasOf`
  continues key-based lookup, so declaration reordering cannot silently bind the
  wrong field. No widening to `ZodType<Output>` loses input types, schema methods,
  transforms or brands. Synthesized data-quality fields retain their existing
  composition.
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

## Current conclusion

This branch contains only the requested-root label-path experiment. It is not a
recommended performance change: the complete web graph barely shrinks and no
repeatable CPU/RSS win appears. Standalone schemas likewise do not show a
repeatable cold improvement. An initial incremental schema probe showed a larger
type-count reduction, but it was not cold-to-cold and is excluded from these
conclusions. No dramatic speedup has been demonstrated.

The expanded label contract checks pass on both baseline and candidate: nullable
array members, indexed arrays, string brands, transforms to strings, and rejection
of missing keys and numeric outputs. Full web diagnostics remain exactly the six
inherited errors listed above. No source coverage or required check was removed.

The comparison harness is [scripts/benchmark-typecheck.py](../../scripts/benchmark-typecheck.py).
Run it first with `baseline`, then with each variant name, in the same prepared
checkout. For the separate schema program use `--project packages/schemas/tsconfig.json --cold-only`
and baseline first for that project. [Raw measurements](typescript-experiments-2026-10.csv)
retain exit codes and compiler counters. The shell preparation command uses
`--no-default-features` for the browser WASM build only, matching the repository.

Added contract tests were run separately from the timing matrix so the original
benchmark workload remained identical across variants. Nothing was deleted other
than the superseded eager label-path validation type aliases.

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

Cold compiler work (repeat counts agree unless stated):

| Variant          | Files |   Types | Instantiations |
| ---------------- | ----: | ------: | -------------: |
| baseline         | 10694 | 3942894 |       23772076 |
| labels           | 10694 | 3941692 |       23770348 |
| baseline-schemas |   561 |  448815 |        1493981 |
| labels-schemas   |   561 |  447370 |        1486058 |
