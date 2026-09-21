/**
 * The one definition of the `cubby` Sentry project DSN.
 *
 * A DSN is an identifier, not a credential: it permits event submission only
 * and is embedded in the browser bundle by design. Every JS surface that
 * reports to the `cubby` project imports it from here — the web client and
 * Worker, the dev-only Node preload, and the auxiliary Workers — so it is
 * defined exactly once. This module carries nothing but the constant, so the
 * browser bundle and the Node preload never pull in the `cloudflare:workers`
 * helpers from `./index.ts`. (The native app uses a separate `cubby-apple`
 * project and keeps its own DSN.)
 */
export const CUBBY_SENTRY_DSN =
  "https://a50b2f76dd1586f95cdd29cd13a6c0dc@o83311.ingest.us.sentry.io/4508775559135232";
