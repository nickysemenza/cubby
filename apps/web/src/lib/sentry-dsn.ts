// Single source of truth for the Sentry DSN. A DSN is not a secret — it's
// embedded in the client bundle by design — so hardcoding it is fine.
//
// Used by the browser init (router.tsx) and the Workers server init
// (cf-server.ts). The dev-only preload `instrument.server.mjs` keeps a literal
// copy because it runs via `node --import` before any TS transpilation and so
// cannot import this module — keep that copy in sync with this value.
export const SENTRY_DSN =
  "https://a50b2f76dd1586f95cdd29cd13a6c0dc@o83311.ingest.us.sentry.io/4508775559135232";
