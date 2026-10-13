import type { Rpc } from "@cloudflare/workers-types";
import type {
  DatabaseWorkRequest,
  DatabaseWorkSnapshot,
  DatabaseWorkReady,
} from "@cubby/schemas/database-work";
// Types only, importing nothing but schema types: the global
// worker-configuration.d.ts reaches this file through worker-bindings.ts, and
// tsc re-checks the whole program after an edit to anything it reaches
// (docs/reports/local-check-performance.md#typechecking).
import type { ProblemsCount } from "@cubby/schemas/problems";

/** Runtime capacity only; no household record is reserved or locked. */
interface DatabaseWorkTicket extends Rpc.RpcTargetBranded {
  ready(): Promise<DatabaseWorkReady>;
  release(): void;
}

export interface DatabaseFreshness {
  lastWriteAt: number;
  strongUntil: number;
}

/** What callers reach through the `DB_FRESHNESS` stub; the Durable Object implements it. */
export interface DatabaseFreshnessRpc {
  readFreshness(): DatabaseFreshness;
  recordWrite(): Promise<DatabaseFreshness>;
  getProblemCounts(): Promise<ProblemsCount>;
  requestDatabaseWork(request: DatabaseWorkRequest): DatabaseWorkTicket;
  databaseWorkSnapshot(): DatabaseWorkSnapshot;
}
