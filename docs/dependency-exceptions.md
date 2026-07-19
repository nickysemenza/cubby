# Dependency exceptions

Cubby's dependency gates reject unallowlisted high and critical advisories. The
small set of non-security exceptions below exists because upstream peer metadata
or transitive deprecations currently lags versions that Cubby verifies directly.
Review these by **2026-10-10** (90 days from the cleanup), and remove an exception
as soon as the upstream range is corrected.

## Direct pins and peer ranges

- `@daveyplate/better-auth-ui` is pinned to `3.3.15`. Its newer release line has
  an unresolved Better Auth API-key / `better-call` peer conflict. The pin also
  brings the deprecated React Email 1.x component family transitively; Cubby does
  not import those packages directly.
- `@triplit/logger@0.0.3` declares TypeScript `^5`, although it is runtime-only
  logging code and Cubby typechecks clean on TypeScript 7.
  `peerDependencyRules.allowedVersions.typescript` accepts versions 5–7 while
  this metadata catches up.
- Wrangler 4.110 requires Workers Types 5 while Sentry 10.65 still declares
  Workers Types 4. Cubby uses Workers Types 5, regenerates all Worker bindings,
  and typechecks clean on TypeScript 7. The peer exception accepts only majors 4–5.

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
