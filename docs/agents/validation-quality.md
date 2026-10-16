# Quality and local diagnostics

`pnpm typecheck:web` checks web app code for web-only work; it leaves out
tests and test tooling. When tests or test tooling change,
include `pnpm typecheck` as an affected check: passing Vitest does not
prove those files typecheck. This checks the full program that `pnpm check` and
CI run. Tests use the configured TypeScript libraries; runtime support for an
API does not establish that the configured libraries expose it.
Use these entry points so generation and WASM are ready. They run `tsc`
directly; there is no machine-wide typecheck queue. Preserve incremental
build-info within a checkout, reuse unchanged results, and coordinate heavy
checks across sessions because cold typechecks can consume substantial memory.
The root `package.json` owns each static-check command composition.
Dependency advisory audits and deduplication are maintenance, not validation gates.

When removing callers or changing exports, include Knip's unused-export check;
the files/dependencies-only `knip:production` command cannot establish export readiness.
The `knip` gate also runs `pnpm knip:production`, which fails on a file or
dependency the production graph never reaches. A script invoked only by a hook,
CI, or package script needs a `!` entry in `knip.json`; a test seam (fixture,
mock, harness) belongs in the negated `project` patterns. Name reusable test
fixtures `*.fixtures.ts` or `*.fixtures.tsx` to match the existing exclusion;
do not add production entry points or per-file ignores for test-only modules.
Scoped lint tests temporarily write under `apps/web/src/server/.lint-fixture-*`
so path-sensitive rules execute. Knip excludes only that disposable directory
pattern because its scan runs concurrently with those tests; lint still checks
the fixtures and removes them afterward. Persisted sampled-path regressions
select their path explicitly through the existing service ports rather than
hoping randomly generated record IDs enter the production sample.

`pnpm verify:local` runs the clean-tree full graph sequentially. Its target
order is not dependency order; Nx supplies generation and build prerequisites.
`pnpm verify:local:full` sets `NX_SKIP_NX_CACHE=true`. Verifier entrypoints
disable the Nx daemon. Stop only processes this task started; use `pnpm exec nx
reset` after interrupting its own interactive Nx work.

Merge-gate targets key on the broad `gate` input in `nx.json`, so a cached pass
is reused only for identical non-documentation content and toolchain. A target
that starts reading something outside that set (an ignored file, Markdown, an
environment variable, a tool outside the workspace) must add it to its inputs,
or a cached pass can hide a regression ([CI](../ci.md#cache-keys-and-the-remote-cache)).

Oxlint's project rules protect unsafe identifier boundaries and soft-delete
filters. The SQL vocabulary rule reads every schema enum: adding a value can
expose literals in otherwise unchanged consumers. Run the lint gate after a
vocabulary addition and shrink its baseline when replacing existing literals. Keep constraint-focused one-line local exceptions. Oxfmt owns
maintained source, CSS, Markdown, MDX, YAML, and TOML; generated files,
the pnpm lockfile, and vendored/build output remain excluded. Do not weaken a
gate to accommodate a change.

Lint policy the exceptions follow:

- `complexity` allows 50; a function above that keeps a one-line disable
  naming why its branches belong together.
- `anti-slop/no-unknown-parameters` checks exported signatures only (module
  boundaries); private helpers, callbacks, and test files may take `unknown`.
- `anti-slop/require-safety-comment-for-type-assertion` needs a `SAFETY:`
  comment on every assertion except `as const`, narrowing to literal types
  (`as "open" | "closed"`), and test files. `as never`, `as unknown as`, and
  other widening casts always need one.
- `vitest/no-conditional-expect` stays on. Assert the discriminant, then
  narrow with an early return instead of wrapping expectations in a branch:

  ```ts
  expect(result.isOk()).toBe(true);
  if (!result.isOk()) return;
  expect(result.value.unit).toBe("$");
  ```

Generated output is never committed. `pnpm install`, `build`, `typecheck` and
every test entry point run `scripts/ensure.ts generate`, which runs the
Nx-cached `cubby-checks:generate` target (a hit also restores missing output);
`pnpm generate` forces a run. Cache restores are pruned against the artifact
manifest, including wholly retired output directories, before consumers read
generated sources. The
Swift OpenAPI client is built by the swift-openapi-generator SwiftPM plugin
and the UniFFI shim by `apps/apple/scripts/build-rust.sh`.

When changing compiled entity declaration shapes, run the affected compiler
contracts in `apps/web/tooling/entity-generator.unit.test.ts` as well as the
consumer regression. Successful generation does not check existing exact-shape
expectations.

Testing Library role queries match string names exactly by default; `exact` is
a Playwright locator option.

In browser tests, use `chooseOption` for enum Pickers rendered as button
comboboxes. `selectComboboxItem` fills a searchable entity Picker input; it
cannot select an enum button. Match the rendered control before choosing a helper.
