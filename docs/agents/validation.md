# Validation, CI, and delivery

## Test placement

Choose by what can fail: unit (`*.unit.test.ts`, pure/node), UI
(`*.unit.test.tsx`, jsdom/RTL), integration (`*.integration.test.ts`, real
Postgres through IntegreSQL), E2E (`tests/e2e/**/*.spec.ts`, built browser app).
Write the lowest tier that can expose the regression; do not duplicate the same
assertion across tiers. Real SQL invariants remain integration tests. Guard
scripts that CI depends on remain load-bearing.

## Commands and ownership

Prefer a single Vitest file while editing. `pnpm test:unit`, `pnpm test:ui`,
`pnpm test:integration` (requires `docker compose -p cubby up -d`), and
`pnpm test:e2e` are the normal tiers. Reserve full `pnpm test` for pre-PR or
cross-layer work.

One agent owns a particular gate; other agents continue useful work and consume
the owner's distilled result instead of repeating it. At handoff report commands,
results, and limitations. CI remains authoritative and runs full coverage.

## PR and CI

Inspect failing check logs and annotations before editing. Fix only failures
caused by the change; retain unrelated flakes or infrastructure failures as
reported. Use an isolated worktree for PR maintenance when the configured
checkout must stay untouched. Outward-facing GitHub text never contains real
household data.

For detailed test/CI exceptions, load the relevant heading in [the preserved
root reference](root-rules-reference.md).
