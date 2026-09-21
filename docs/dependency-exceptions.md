# Dependency exceptions

Cubby's dependency gates reject unallowlisted high and critical advisories. The
small set of non-security exceptions below exists because upstream peer metadata
or transitive deprecations currently lags versions that Cubby verifies directly.
Review these by **2026-10-10** (90 days from the cleanup), and remove an exception
as soon as the upstream range is corrected.

## Direct pins and peer ranges

- `@daveyplate/better-auth-ui` is pinned to `3.4.0`. Its `@better-auth/api-key`
  transitive still peers `better-call@1.3.7` while the UI resolves `better-call`
  2.x; Cubby uses no API-key features, so the peer exception accepts major 2.
  The pin also brings the deprecated React Email 1.x component family
  transitively; Cubby does not import those packages directly.
- `@cloudflare/tanstack-ai@0.2.1` bundles grok/gemini/openrouter/openai adapters
  that peer `@tanstack/ai` `^0.40`. Cubby imports only the anthropic adapter,
  and `@tanstack/ai-anthropic` requires `^0.41`, so the peer exception accepts
  `^0.41.0` until Cloudflare republishes against 0.41.
- `@triplit/logger@0.0.3` declares TypeScript `^5`, although it is runtime-only
  logging code and Cubby typechecks clean on TypeScript 7.
  `peerDependencyRules.allowedVersions.typescript` accepts versions 5–7 while
  this metadata catches up.
- Wrangler 4.112 requires Workers Types 5 while Sentry 10.66 still declares
  Workers Types 4. Cubby uses Workers Types 5, regenerates all Worker bindings,
  and typechecks clean on TypeScript 7. The peer exception accepts only majors 4–5.
- `@cubby/web-worker-tests` pins Vitest 4.1.10 and
  `@cloudflare/vitest-plugin` 1.1.5. The plugin still peers on `vitest ^4.1.0`
  and depends on its internal APIs; plugin 1.1.13's Miniflare/workerd pair
  fails before collection with `SyntaxError: Unexpected identifier 'file'`.
  The isolated package runs only the workerd suites; every application and
  library test suite runs Vitest 5.

## Deprecated transitive packages

- `@esbuild-kit/*` comes from `drizzle-kit` and is build-only.
- `glob@10` comes through OpenTelemetry's GCP resource detector.
- `uuid@8` comes from `@hookform/devtools`; `uuid@10` comes from the Vite
  top-level-await build plugin. Neither is an application dependency.
- React Email 1.x subpackages come solely from the pinned Better Auth UI package.

These packages have no active production advisory under `pnpm audit --prod`.
They are documented rather than overridden: an override could substitute an API-
incompatible major inside another package. Renovate should continue proposing
upstream updates normally.
