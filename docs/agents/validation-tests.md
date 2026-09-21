# Test tiers and runtime traps

Use unit tests for pure logic, UI tests for rendered behavior, PostgreSQL tests
for constraints/transactions/query behavior, and E2E for the built browser
application. A `.tsx` change under `apps/web/src` needs the UI tier. Keep pure
logic imported by node tests in alias-free `.ts` files.

`pnpm test` runs fast unit, UI, contract, and auxiliary tests; `pnpm
test:postgres` runs contract tests; `pnpm test:e2e` runs PostgreSQL-backed
browser tests; `pnpm test:all` runs fast, PostgreSQL, then Playwright
sequentially. Do not overlap PostgreSQL and E2E locally: they contend for
containers, workerd, browsers, and database connections. Other workspace
packages need `pnpm -r --filter '!@cubby/web' run test` after changing
`packages/*`.

Target a browser spec as `pnpm test:e2e <spec>` without an extra `--`. E2E
serves `dist/`, so build it before a standalone run; `verify:local` does. A
standalone Playwright request context inherits project storage state unless it
sets empty cookies and origins. RTable's placeholder transition can eat clicks;
cell-edit tests retry opening and filling as one action.

Run `pnpm wasm` after WASM changes. The shared `CARGO_TARGET_DIR` can be
written by another checkout, so confirm generated output is current. Generated
API changes require the owning generated-surface workflow and affected native
checks.
