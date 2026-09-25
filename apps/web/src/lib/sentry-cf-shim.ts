/**
 * SSR-only stand-in for `@sentry/tanstackstart-react` on Cloudflare Workers.
 *
 * `vite.config.ts`'s `cfSentryShim()` resolves every SSR import of
 * `@sentry/tanstackstart-react` here when `DEPLOY_TARGET=cloudflare`. It is
 * never used by the client build, and never in dev.
 *
 * Why: that package's server half re-exports `@sentry/node`, which drags
 * `@sentry/node-core`, `@sentry/opentelemetry`, `@sentry/server-utils`, seven
 * `@opentelemetry/*` packages, `require-in-the-middle` and
 * `import-in-the-middle` into the worker — ~600 KiB of Node-only code welded
 * into the eager root chunk, none of which can run on workerd. The worker's
 * real SDK is `@sentry/cloudflare`, initialised by `withSentry` in
 * `cf-server.ts`.
 *
 * This must export every binding the SSR graph reaches:
 *   - `captureException` — server workflow handlers, components/route-error.tsx.
 *     Genuinely used on the server; forwards to the Cloudflare SDK, which
 *     shares `@sentry/core`'s scope with the `withSentry` init.
 *   - `captureMessage` — catch-up.service.ts warnings. Same forwarding.
 *   - `init`, `tanstackRouterBrowserTracingIntegration` — router.tsx. Both sit
 *     behind `if (!router.isServer)`, so they are never called during SSR;
 *     these exist only so the module shape matches.
 *   - `wrapFetchWithSentry` — server.ts, behind `isCfBuild ? … : …`, so also
 *     never called in this build. Identity is the correct fallback regardless:
 *     `withSentry` already wraps the worker's fetch.
 *   - `startInactiveSpan` — the client navigation tracker. The install call is
 *     guarded by `router.isServer`, so SSR only needs a shape-compatible no-op.
 *
 * Adding a new `Sentry.*` call to isomorphic or server code means adding it
 * here too. vite.config.ts fails the SSR build on IMPORT_IS_UNDEFINED so a
 * missing export can't ship as `undefined is not a function` on the error path.
 */
export { captureException, captureMessage } from "@sentry/cloudflare";

type SentryBrowserApi = typeof import("@sentry/tanstackstart-react");
type SentryInitOptions = Parameters<SentryBrowserApi["init"]>[0];
type SentryRouter = Parameters<
  SentryBrowserApi["tanstackRouterBrowserTracingIntegration"]
>[0];
type SentrySpanOptions = Parameters<SentryBrowserApi["startInactiveSpan"]>[0];
type SentrySpanAttributes = Parameters<
  ReturnType<SentryBrowserApi["startInactiveSpan"]>["setAttributes"]
>[0];

/** No-op: client-only, guarded by `!router.isServer` in router.tsx. */
export function init(_options?: SentryInitOptions): void {}

/** No-op: client-only, guarded by `!router.isServer` in router.tsx. */
export function tanstackRouterBrowserTracingIntegration(
  _router?: SentryRouter,
) {
  return { name: "TanStackRouterBrowserTracing" };
}

/** No-op span: navigation timing is client-only. */
export function startInactiveSpan(_options?: SentrySpanOptions) {
  return {
    setAttributes: (_attributes: SentrySpanAttributes) => {},
    end: () => {},
  };
}

/** Identity: the worker's fetch is already wrapped by `withSentry`. */
export function wrapFetchWithSentry<T>(handler: T): T {
  return handler;
}
