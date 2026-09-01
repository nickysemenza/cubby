/**
 * Browser acceptance preserves production queue dispatch but does not repeat
 * the background processors' PostgreSQL contract tests. Successful return
 * acknowledges every message immediately.
 */
export default {
  queue(): void {},
};
