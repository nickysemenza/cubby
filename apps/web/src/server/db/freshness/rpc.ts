// Types only, importing nothing: the global
// worker-environment.d.ts reaches this file through worker-bindings.ts, and
// tsc re-checks the whole program after an edit to anything it reaches
// (`git show 18f8bd430:docs/reports/local-check-performance.md`).

export interface DatabaseFreshness {
  lastWriteAt: number;
  strongUntil: number;
}

/** What callers reach through the `DB_FRESHNESS` stub; the Durable Object implements it. */
export interface DatabaseFreshnessRpc {
  readFreshness(): DatabaseFreshness;
  recordWrite(): Promise<DatabaseFreshness>;
  publishChanges(categories: string[]): Promise<void>;
  fetch(request: Request): Promise<Response>;
}
