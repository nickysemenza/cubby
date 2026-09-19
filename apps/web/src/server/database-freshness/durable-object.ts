import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  type ProblemsCount,
  problemsCountSchema,
} from "@cubby/schemas/problems";
import { DurableObject } from "cloudflare:workers";

import { runWithExecutionCtx, setCfEnv } from "~/server/cf-env";
import type { findProblemCountsSnapshot } from "~/server/services/problems.service";

import { databaseFreshness } from "./state";

const REFRESH_DELAY_MS = 15 * 60_000;
const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60_000;

// SAFETY: this module's named export is declared locally and remains lazy so
// workerd does not initialize the WASM-backed problem implementation at boot.
const loadProblemCountsService = () =>
  import("~/server/services/problems.service") as Promise<{
    findProblemCountsSnapshot: typeof findProblemCountsSnapshot;
  }>;

type SnapshotQuality = "complete" | "degraded";

type SnapshotRow = {
  counts_json: string;
  computed_at: number;
  quality: SnapshotQuality;
};

/** One timestamp per database environment, shared by every household client. */
export class DatabaseFreshnessDurableObject extends DurableObject<Env> {
  private refreshTail: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS freshness (id INTEGER PRIMARY KEY CHECK (id = 1), last_write_at REAL NOT NULL)",
    );
    ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO freshness (id, last_write_at) VALUES (1, ?)",
      Date.now(),
    );
    const columns = Array.from(
      ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(freshness)"),
    );
    if (!columns.some(({ name }) => name === "write_sequence")) {
      ctx.storage.sql.exec(
        "ALTER TABLE freshness ADD COLUMN write_sequence INTEGER NOT NULL DEFAULT 0",
      );
    }
    if (!columns.some(({ name }) => name === "refresh_due_at")) {
      ctx.storage.sql.exec(
        "ALTER TABLE freshness ADD COLUMN refresh_due_at REAL",
      );
    }
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS problem_counts (id INTEGER PRIMARY KEY CHECK (id = 1), counts_json TEXT NOT NULL, computed_at REAL NOT NULL, covered_sequence INTEGER NOT NULL, quality TEXT NOT NULL CHECK (quality IN ('complete', 'degraded')))",
    );
  }

  readFreshness() {
    const row = this.ctx.storage.sql
      .exec<{ last_write_at: number }>(
        "SELECT last_write_at FROM freshness WHERE id = 1",
      )
      .one();
    return databaseFreshness(row.last_write_at);
  }

  async recordWrite() {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "UPDATE freshness SET last_write_at = MAX(last_write_at, ?), write_sequence = write_sequence + 1, refresh_due_at = COALESCE(refresh_due_at, ?) WHERE id = 1",
      now,
      now + REFRESH_DELAY_MS,
    );
    await this.ensureRefreshAlarm();
    return this.readFreshness();
  }

  async getProblemCounts(): Promise<ProblemsCount> {
    const existing = this.readSnapshot();
    if (existing) {
      if (Date.now() - existing.computedAt >= MAX_SNAPSHOT_AGE_MS) {
        await this.scheduleRefresh(Date.now() + REFRESH_DELAY_MS);
      }
      return existing.counts;
    }
    try {
      await this.serializeRefresh(async () => {
        if (!this.readSnapshot()) await this.refresh();
      });
    } catch (error) {
      await this.scheduleRefresh(Date.now() + REFRESH_DELAY_MS);
      throw error;
    }
    const snapshot = this.readSnapshot();
    if (!snapshot) throw new Error("Problem-count snapshot was not published");
    return snapshot.counts;
  }

  async alarm(): Promise<void> {
    if (this.readRefreshState().refresh_due_at === null) return;
    try {
      await this.serializeRefresh(() => this.refresh());
    } catch (error) {
      await this.scheduleRefresh(Date.now() + REFRESH_DELAY_MS);
      const retryAt = this.readRefreshState().refresh_due_at;
      if (retryAt !== null) await this.ctx.storage.setAlarm(retryAt);
      console.error("problems.counts.refresh.failed", error);
      return;
    }
    const { refresh_due_at: dueAt } = this.readRefreshState();
    if (dueAt !== null) await this.ctx.storage.setAlarm(dueAt);
  }

  private serializeRefresh(run: () => Promise<void>): Promise<void> {
    const refresh = this.refreshTail.then(run, run);
    this.refreshTail = refresh.catch(() => undefined);
    return refresh;
  }

  private readRefreshState() {
    return this.ctx.storage.sql
      .exec<{
        write_sequence: number;
        refresh_due_at: number | null;
      }>("SELECT write_sequence, refresh_due_at FROM freshness WHERE id = 1")
      .one();
  }

  private async scheduleRefresh(requestedAt: number): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE freshness SET refresh_due_at = CASE WHEN refresh_due_at IS NULL OR refresh_due_at > ? THEN ? ELSE refresh_due_at END WHERE id = 1",
      requestedAt,
      requestedAt,
    );
    await this.ensureRefreshAlarm();
  }

  private async ensureRefreshAlarm(): Promise<void> {
    const dueAt = this.readRefreshState().refresh_due_at;
    const alarmAt = await this.ctx.storage.getAlarm();
    if (dueAt !== null && (alarmAt === null || dueAt < alarmAt)) {
      await this.ctx.storage.setAlarm(dueAt);
    }
  }

  private readSnapshot(): {
    counts: ProblemsCount;
    computedAt: number;
    quality: SnapshotQuality;
  } | null {
    const row = this.ctx.storage.sql
      .exec<SnapshotRow>(
        "SELECT counts_json, computed_at, quality FROM problem_counts WHERE id = 1",
      )
      .toArray()[0];
    if (!row) return null;
    let encoded: unknown;
    try {
      encoded = JSON.parse(row.counts_json);
    } catch (error) {
      console.error("problems.counts.snapshot.invalid-json", error);
      return null;
    }
    const parsed = problemsCountSchema.safeParse(encoded);
    if (!parsed.success) {
      console.error("problems.counts.snapshot.invalid", parsed.error.message);
      return null;
    }
    return {
      counts: parsed.data,
      computedAt: row.computed_at,
      quality: row.quality,
    };
  }

  private async refresh(): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE freshness SET refresh_due_at = NULL WHERE id = 1",
    );
    const coveredSequence = this.readRefreshState().write_sequence;
    const result = await this.computeProblemCounts();
    const previous = this.readSnapshot();
    if (!(result.quality === "degraded" && previous?.quality === "complete")) {
      this.ctx.storage.sql.exec(
        "INSERT INTO problem_counts (id, counts_json, computed_at, covered_sequence, quality) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET counts_json = excluded.counts_json, computed_at = excluded.computed_at, covered_sequence = excluded.covered_sequence, quality = excluded.quality",
        JSON.stringify(problemsCountSchema.parse(result.counts)),
        Date.now(),
        coveredSequence,
        result.quality,
      );
    }
    if (result.quality === "degraded") {
      await this.scheduleRefresh(Date.now() + REFRESH_DELAY_MS);
    }
  }

  private async computeProblemCounts() {
    const connectionString = this.env.HYPERDRIVE?.connectionString;
    if (!connectionString) {
      throw new Error("Problem-count PostgreSQL backend is unavailable");
    }
    setCfEnv(this.env);
    const [{ db, withRequestDbClient }, { createUpcLookupClient }, service] =
      await Promise.all([
        import("~/server/db"),
        import("~/server/clients/upc-lookup"),
        loadProblemCountsService(),
      ]);
    return runWithExecutionCtx(
      { waitUntil: (task) => this.ctx.waitUntil(task) },
      () =>
        withRequestDbClient(connectionString, () =>
          service.findProblemCountsSnapshot(db, createUpcLookupClient()),
        ),
      this.env.APP_ORIGIN,
    );
  }
}
