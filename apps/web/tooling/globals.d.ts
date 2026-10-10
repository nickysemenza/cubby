// Test and dev-tooling globals. A `.ts` module with `declare global` is a
// global-scope file, and TypeScript re-checks the whole program whenever one
// falls in an edit's importer closure; `integration-teardown.ts` is reached
// from most server modules through `test-setup.ts`
// (docs/local-check-performance.md#typechecking).

// Read by `integration-teardown.ts`. Process-wide: `isolate: false` reruns that
// setup file per test file, but the pg prototype is patched once, so the list
// must outlive each run.
declare var cubbyPgConcurrentQueries: Error[] | undefined;

interface Window {
  // Set by the HMR probe module `tests/e2e/dev-runtime.hmr.ts` writes into the dev server.
  __cubbyHmrProbe?: string;
}
