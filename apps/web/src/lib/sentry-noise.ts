// Known-noise error messages dropped before they consume the free-plan error
// quota. Sentry's `ignoreErrors` matches an event's message/exception value
// against these entries (substring match for a string, `.test()` for a
// RegExp) and drops the event before it is sent — none of these count against
// quota. Shared between the browser init (router.tsx) and the Worker init
// (cf-server.ts) so both drop the same noise.
export const SENTRY_IGNORED_ERRORS: (string | RegExp)[] = [
  // workerd `HTTPError` thrown when the browser aborts an in-flight
  // `/_serverFn` request (compat flag `enable_request_signal`). Fired 1k+
  // times in 30 days; carries no stack and isn't actionable.
  "The client has disconnected",
  // AI Gateway "Wholesale Rate limited" (HTTP 429) after `src/server/ai/jev.ts`
  // exhausts its retries. Fired 1k+ times in 30 days; expected backpressure —
  // the client already treats suggestion failures as silent.
  /^Jev request failed \(429\)/,
  // Vectorize rate limit surfaced inside the embedding background task.
  // Fired 1k+ times in 30 days; a dedicated backoff is a separate follow-up.
  /VECTOR_UPSERT_ERROR \(code = 40041\)/,
];
