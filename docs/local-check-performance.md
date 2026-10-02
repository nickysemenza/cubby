# Local check and calendar performance

Each section records its own date. These are local diagnostics on ARM macOS,
not a comparison with hosted x86 CI.

## Typechecking

Measured October 1, 2026 on the 8-core, 24 GiB ARM Mac with TypeScript 7.0.2,
`/usr/bin/time -l`, load average 5–20. Wall time moves with load; CPU and peak
RSS are the comparable figures.

`pnpm --dir apps/web typecheck` runs `scripts/typecheck-web.ts`, which runs
`tsc --noEmit --checkers 1`. One checker avoids duplicating the large generic
type graph: in September it halved CPU (50.4 → 21.5 s) and RSS (5.9 → 3.1 GB)
without excluding files or changing diagnostics.

| Run                                         |    Wall |     CPU | Peak RSS |
| ------------------------------------------- | ------: | ------: | -------: |
| Cold, no buildinfo                          | 20–22 s | 32–34 s |   6.2 GB |
| Buildinfo copied from a days-old checkout   |    46 s |    71 s |   7.6 GB |
| Warm, nothing changed                       |   1–2 s |   3–4 s |   1.5 GB |
| Warm, body edit to a file already re-signed | 1.5–3 s |   4–7 s |   2.0 GB |
| Warm, shape change: 3 of 10 sampled files   |     2 s |   4–5 s |   2.0 GB |
| Warm, shape change: 3 of 10 sampled files   |    20 s | 28–32 s |   6.2 GB |
| Warm, shape change: 4 of 10 sampled files   |    37 s | 50–54 s |   7.0 GB |

The program is about 9,100 files, 3.3M types and 19.3M instantiations (10.1M
in September). Zod accounts for a quarter of all types. The cost is spread
thin: the slowest file (`entity-list-read-bindings.gen.ts`) is about 1.3 s of
a 24 s check, and annotating it saved only 0.2 s, so it was not kept.

**The resident set is live data.** `GOGC=25` cut peak RSS 7% for 73% more
CPU; `GOMEMLIMIT=2GiB` took 13× the CPU. Concurrent checks therefore cannot
shrink, only queue: the wrapper holds one of two machine-wide slots under
`~/.cache/cubby/typecheck-slots` (`CUBBY_TYPECHECK_SLOTS`; skipped in CI),
reclaiming slots whose holder died.

**Why a small edit can cost more than a cold check.** Under `--noEmit`, tsc
never emits declarations, so a fresh build records each file's version as its
"signature". The first change to a file after that, even inside a function
body, looks like a declaration-shape change. A shape change drops cached
diagnostics for every file that transitively imports the changed file's
direct importers (Strada and TS 7 alike; `isolatedModules` changes only emit)
and for _every_ file once a global-scope file falls in that set. Later body
edits to the same file compare real signatures and stay cheap. Two structures
make the invalidated set large:

- `routeTree.gen.ts` augments `@tanstack/react-router` and
  `@tanstack/react-start`, so each of the ~330 files importing them references
  it, and it imports every route. About 1,930 of 3,450 source files
  transitively import `router.tsx` (the 20 s row).
- `worker-configuration.d.ts` is a global script, and `wrangler types` points
  its Durable Object and Workflow types at the Worker entry
  (`import("./src/cf-server")`), which reaches the route tree through the
  `@tanstack/react-start` server entry. A closure that reaches it re-checks
  all 3,457 files (the 37 s row). `types:generate` now rewrites those imports
  to `src/server/worker-bindings.ts`, which exports only those classes
  (`scripts/worker-type-imports.ts`; Wrangler's `--check` compares only its
  hash header). Moving the `declare global` blocks out of three `.ts` files
  alone measured no change, because the same closures reach this file.

Server modules no longer type-import client modules. The generated kernel
bindings carried the port-existence check (`EntityPortExportChecks`, now in
the unimported `entity-port-checks.gen.ts`), and the problem-registry
validator read `getSortableFields` from `entities.tsx` (the roster lookup is
now the leaf `entities/sortable-fields.ts`). Those two edges let 476 of 669
server files reach the route tree; four do now (`cf-server.ts` and three
`@tanstack/react-start` middleware files). With a fresh build per probe and
one body edit, the same 10 files went from 51.5–61.8 s CPU (mean 54.3 s) to
39.6–57.9 s (mean 43.9 s): about −24% for the eight client files, and no clear
change for the two server files, which still escalate through `cf-server.ts`.

With the env types pointed at `worker-bindings.ts`, a global file sits in the
closure of 760 of 2,940 source files, mostly server modules the Durable
Objects reach. The eight client files then took 26.4–28.6 s CPU, down from
52.6–56.0 s on the original layout: they now re-check the route-tree closure
instead of everything. The two server files still re-check everything
(56–71 s).

Server modules no longer type-import client modules. The generated kernel
bindings carried the port-existence check (`EntityPortExportChecks`, now in
the unimported `entity-port-checks.gen.ts`), and the problem-registry
validator read `getSortableFields` from `entities.tsx` (the roster lookup is
now the leaf `entities/sortable-fields.ts`). Those two edges let 476 of 669
server files reach the route tree; four do now (`cf-server.ts` and three
`@tanstack/react-start` middleware files). With a fresh build per probe and
one body edit, the same 10 files went from 51.5–61.8 s CPU (mean 54.3 s) to
39.6–57.9 s (mean 43.9 s): about −24% for the eight client files, and no clear
change for the two server files, which still escalate through `cf-server.ts`.

Emitting declarations to a cache directory would record real signatures from
the start, but it reports 482 new declaration errors (mostly TS4023 and
TS2883), and the fresh build took 68 s of CPU and 9.6 GB.

A buildinfo many commits old pays a declaration-signature emit per changed
file and then re-checks nearly everything, which is why the copied buildinfo
above costs twice a cold run. The wrapper records content hashes of the
buildinfo's files after each completed run and deletes the buildinfo when more
than 100 changed (a rebase or pull) or no record exists; `.worktreeinclude` no
longer copies it into new worktrees.

`apps/purchase-agent/src/service.ts` typed one parameter with Flue's
`CloudflareContext`, pulling pi-ai, a second OpenAI and Anthropic SDK, and
typebox (about 1,000 declaration files) into the web program through one
tooling import. Unused declarations cost parse and bind only: dropping them
saved about 110 MB and no check time.

## Calendar tests and generation

Measured September 7, 2026.

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

`pnpm verify:local:full` passed
in **124.47 seconds** on the 8-core, 24 GiB ARM Mac, measured with
`/usr/bin/time -p`. This warm run includes WASM preparation, frozen dependency
installation, all repository checks, dependency deduplication, Rust formatting,
Clippy and tests, all Worker builds, workspace tests, PostgreSQL and Playwright.
The PostgreSQL and browser tiers overlap through the existing npm runner after
the fast tier; neither test coverage nor browser worker limits changed.

Warm web tests passed all 3,442 cases in 18.87 seconds; PostgreSQL passed all
262 cases in 29.07 seconds, alongside all 22 passing browser tests. Measured on
code commit `7f7f2c13d` with local Node 26.7.0 (hosted configuration pins Node
24); this is one observation, not a controlled comparison or a measurement of
aggregate process-tree memory. The typechecker RSS measurements above remain
separate. Commands: [quality guide](agents/validation-quality.md).

## Excluded claims

Changing Rust test/Clippy order was explored but not retained locally. The
three-second Clippy result reused earlier Clippy output and was not a valid cold
comparison. No tests, required checks, production APIs, or schemas were removed
or weakened to obtain these results.

## Worktree setup and caches

The historical setup and cache experiments are preserved in Git history. The
retained boundaries are:

- pnpm imports package contents from its content-addressable store using
  hardlinks or filesystem clones. A per-project `node_modules` can report
  gigabytes without consuming that much additional space. The global virtual
  store shares dependency graphs as well, leaving each checkout with symlinks
  to those graphs instead of a local `.pnpm` tree. Published type declarations
  must declare their type dependencies to work in that layout; dependencies
  available only through project-local hoisting need narrow package extensions.
  Measure reclaimed space using the filesystem's available space before and
  after cleanup, rather than adding up worktree `node_modules` sizes.
  Cubby uses `virtualStoreType: global` with pnpm 12.4.1, sharing graphs under
  `<pnpm store path>/links`. Package extensions supply the missing optional
  `@types/react` peers for Phosphor, TanStack Router/Table, and cmdk, preserving
  icon props, event types, and table subscription inference without relying on
  checkout-local hoisting. Frozen installs, web type checking, and local web
  startup passed in two fresh worktrees with this layout.
- Nx targets own checks and their declared inputs. The repository-wide static
  checks exclude Markdown and other files those tools do not inspect; Markdown
  changes receive their own link/format validation. The validation policy in
  [agent guidance](agents/validation.md) is the current command authority.
- `ensure-wasm.ts` fingerprints Rust sources, configuration, tool versions, and
  build environment, then restores the complete generated WASM package from
  Nx cache. A local marker avoids a repeat restore when nothing changed.
  Tracking the workspace `Cargo.lock` and excluding `.DS_Store` from the source
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
  compilation cache likewise stayed within measurement noise. XcodeGen now
  places GUI DerivedData under `apps/apple/DerivedData/Cubby` so its lifetime
  follows the checkout rather than leaving a global orphan. Command-line app
  outputs retain `apps/apple/DerivedData`; they do not reuse the GUI build graph.
  Local SwiftPM build/test and OpenAPI warning checks disable indexing, as
  hosted package tests already do. Xcode GUI indexing remains available.

These measurements came from an 8-core ARM Mac under varying load. They are
comparative evidence for the retained choices, not setup-time promises.
