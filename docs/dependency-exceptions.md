# Dependency exceptions

Manifests, `pnpm-workspace.yaml`, and the lockfile own pins, peer exceptions and
resolved transitive versions. Review these exceptions when upgrading their
owner; remove them when upstream metadata is corrected. Advisory audits and
deduplication are dependency maintenance, not validation gates.

- Better Auth UI's optional API-key family has narrower `better-call` peer
  metadata than the resolved UI dependency. Cubby uses no UI API-key feature.
  Its React Email dependencies are transitive, not directly imported.
- `@triplit/logger` is runtime-only but declares a TypeScript peer range that
  lags the compiler Cubby verifies.
- Wrangler and Sentry declare different Workers Types peer majors. Check inferred
  bindings and typecheck when changing either; the workspace owns the accepted range.
- Sentry's bundler plugin requires Babel 7; its package extension supplies that
  major separately from Vite's Babel 8 dependency.
- Agents' PiHarness patch invalidates failed pi-durable sessions at its cache
  boundary, with ownership checks so an old session cannot discard a replacement
  during startup. Remove it when upstream provides equivalent recovery.
- Build-only `@esbuild-kit/*`, OpenTelemetry's `glob`, and transitive `uuid`
  dependencies remain upstream maintenance concerns. A blanket override can
  replace an API with an incompatible major inside another package.

Renovate continues proposing upstream updates; pins do not excuse stale metadata.
