// The DSN is defined once in `@cubby/worker-tracing/sentry-dsn`; this alias
// keeps the browser init (router.tsx) and the Workers server init
// (cf-server.ts) on their existing import. The dev-only preload
// `instrument.server.mjs` imports the same module directly.
export { CUBBY_SENTRY_DSN as SENTRY_DSN } from "@cubby/worker-tracing/sentry-dsn";
