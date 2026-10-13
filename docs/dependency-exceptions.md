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
- Wrangler and Sentry declare different Workers Types peer majors. Regenerate
  bindings and typecheck when changing either; the workspace owns the accepted range.
- The isolated workerd test package pins the Vitest version required by
  Cloudflare's plugin because it uses Vitest internals. Application/library
  tests use their own manifest versions.
- Build-only `@esbuild-kit/*`, OpenTelemetry's `glob`, and transitive `uuid`
  dependencies remain upstream maintenance concerns. A blanket override can
  replace an API with an incompatible major inside another package.

Renovate continues proposing upstream updates; pins do not excuse stale metadata.
