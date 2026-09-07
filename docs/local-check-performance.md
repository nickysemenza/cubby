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

| Setting | Files | Instantiations | Wall time | CPU user time | Peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| Default checkers | 7,403 | 21,307,057 | 12.29 s | 50.44 s | 5.93 GB |
| One checker | 7,403 | 10,148,693 | 12.37 s | 21.52 s | 3.07 GB |

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

## Excluded claims

Changing Rust test/Clippy order was explored but not retained locally. The
three-second Clippy result reused earlier Clippy output and was not a valid cold
comparison. No tests, required checks, production APIs, or schemas were removed
or weakened to obtain these results.
