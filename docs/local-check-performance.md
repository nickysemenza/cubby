# Local check and calendar performance

Measured September 7, 2026 on ARM macOS with TypeScript 7.0.2. These are local
diagnostics, not a comparison with hosted x86 CI.

## Typechecking

The web typecheck now uses `--checkers 1`. The native compiler otherwise checks
the program with multiple independent type graphs. A single checker reduces
duplicate generic instantiations without excluding files or changing diagnostics.
Incremental checking remains enabled; the service-worker check is unchanged.

Representative cold runs (`--noEmit --incremental false --extendedDiagnostics`,
wrapped with `/usr/bin/time -l`):

| Setting          | Files | Instantiations | Wall time | CPU user time | Peak RSS |
| ---------------- | ----: | -------------: | --------: | ------------: | -------: |
| Default checkers | 7,403 |     21,307,057 |   12.29 s |       50.44 s |  5.93 GB |
| One checker      | 7,403 |     10,148,693 |   12.37 s |       21.52 s |  3.07 GB |

This is primarily a memory and CPU improvement, not a demonstrated latency win.
Earlier measurements overlapped trace generation or dependency installation and
are excluded. Two checkers used about 4.03 GB in an exploratory run. A compiler
trace identified a costly literal-union expression in the entity inspector, but
a local annotation did not show a reliable overall improvement and was removed.

The complete warm `pnpm check` baseline took 7.17–7.51 seconds over three runs
(median 7.21 seconds). Revised warm runs took 7.27–10.20 seconds (median
8.11 seconds), about 12% slower at the median in this small sample. Reducing
compiler memory does not eliminate time spent in lint, Knip, and other repository
guards. The first check after changing compiler settings rebuilds its
incremental state and is not a warm measurement.

A single September 14, 2026 run of `pnpm --dir apps/web exec tsc --noEmit
--incremental false --extendedDiagnostics 2>&1 | head -40` (14.345 s total,
5,785,965K peak) printed no line naming a checker count, so the "Default
checkers" row above stays unlabeled with an actual number rather than a guess.

## Calendar tests and generation

ICS line folding previously allocated a UTF-8 byte array for every character.
An oversized-document test exercised millions of these allocations and timed
out in the hosted pilot. Folding now computes each Unicode code point's byte
width without those allocations. Line limits, continuation spaces, surrogate
handling, and rendered text are preserved.

The existing snapshot and ICS test files took 927 ms of test execution before
the change and 119 ms afterward, including five additional folding cases for
ASCII, two-byte, three-byte, supplementary, and unpaired-surrogate text. End-to-end
test-command duration fell from 3.02 to 2.12 seconds. All 27 tests passed.

## Complete local verification

After the local-verification workflow change, `pnpm verify:local:full` passed
in **124.47 seconds** on the 8-core, 24 GiB ARM Mac, measured with
`/usr/bin/time -p`. This warm run includes WASM preparation, frozen dependency
installation, all repository checks, dependency deduplication, Rust formatting,
Clippy and tests, all Worker builds, workspace tests, PostgreSQL and Playwright.
The PostgreSQL and browser tiers overlap through the existing npm runner after
the fast tier; neither test coverage nor browser worker limits changed.

The preceding full pre-push gate and push took 289.37 seconds, including
52.95 seconds of Clippy compilation and 82 seconds of Rust test compilation.
Warm Clippy and Rust test build phases took 0.15 and 0.19 seconds respectively.
Warm web tests passed all 3,442 cases in 18.87 seconds; PostgreSQL passed all
262 cases in 29.07 seconds, alongside all 22 passing browser tests. Both complete
runs passed. Measurements were taken on code commit `7f7f2c13d` using local Node
26.7.0; hosted configuration continues to pin Node 24. These are two observations
with different cache states, not a controlled before/after comparison or a
measurement of aggregate process-tree memory. The typechecker RSS measurements
above remain separate.

## Excluded claims

Changing Rust test/Clippy order was explored but not retained locally. The
three-second Clippy result reused earlier Clippy output and was not a valid cold
comparison. No tests, required checks, production APIs, or schemas were removed
or weakened to obtain these results.

## Worktree setup and caches

The historical setup and cache experiments are preserved in Git history. The
retained boundaries are:

- Nx targets own checks and their declared inputs. The repository-wide static
  checks exclude Markdown and other files those tools do not inspect; Markdown
  changes receive their own link/format validation. The validation policy in
  [agent guidance](agents/validation.md) is the current command authority.
- `ensure-wasm.ts` fingerprints Rust sources, configuration, tool versions, and
  build environment, then restores the complete generated WASM package from
  Nx cache. A local marker avoids a repeat restore when nothing changed.
  Tracking `recipebridge/Cargo.lock` and excluding `.DS_Store` from the source
  digest make that fingerprint stable across worktrees. A measured fresh
  worktree WASM step fell from 54.8 seconds of compilation to a 1.6-second
  cache hit; a warm unchanged check fell from about 7 seconds to 0.3 seconds.
- A shared Cargo path patch once selected an older ingredient-parser checkout
  and broke imports. Updating that checkout fixed the missing API; changing
  installer settings would not have fixed it.
- Wholesale sharing of Xcode `DerivedData` or SwiftPM `.build` across
  worktrees was rejected because intermediates encode absolute source paths
  and concurrent builds contend for one build database. A shared clone
  directory reduced disk use but did not improve build time reliably; a shared
  compilation cache likewise stayed within measurement noise.

These measurements came from an 8-core ARM Mac under varying load. They are
comparative evidence for the retained choices, not setup-time promises.
