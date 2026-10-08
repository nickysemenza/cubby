import type { DurableObjectStorage } from "@cloudflare/workers-types";
import {
  browserBridgeRequest,
  browserBridgeRunCompletion,
  type BrowserBridgeRequest,
  type BrowserBridgeRunCompletion,
} from "@cubby/schemas/purchase-import";

import { browserBridgeResult, type BrowserBridgeResult } from "./contracts";

type CommandRow = {
  request_json: string;
  state: "pending" | "sent" | "completed" | "cancelled";
  result_json: string | null;
};

export type RunCompletionSummary = BrowserBridgeRunCompletion;

// Rows saved before a field existed parse with its default: a stored
// completion is replayed until the Mac acknowledges it.
const runCompletionSummary = browserBridgeRunCompletion.extend({
  terminalStatus:
    browserBridgeRunCompletion.shape.terminalStatus.default("completed"),
});

type ClaimedBrowserResult = {
  command: BrowserBridgeRequest | null;
  newlyCompleted: boolean;
};

/** Durable transport state only. Purchase-import orchestration lives in the coordinator agent. */
export class PurchaseImportSqlStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  migrate(): void {
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS broker_command (request_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, run_id TEXT NOT NULL, request_json TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','sent','completed','cancelled')), result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    this.storage.sql.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS broker_command_operation_key ON broker_command(run_id, operation_id)",
    );
    this.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS broker_command_replay_idx ON broker_command(state, created_at)",
    );
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS broker_completed_command (request_id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL)",
    );
    // Runs whose last browser result failed: a reconnecting Mac wakes the
    // newest one, since a finished command has nothing to replay.
    const wakesExisted =
      this.storage.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'broker_wake'",
        )
        .toArray().length > 0;
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS broker_wake (run_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL)",
    );
    // Once, at the cut to protocol 3: a run whose last step was an older
    // protocol's (even a finished one) is woken, so the server reads it and
    // stops the run for review. Older than a command deadline, the run has
    // already expired.
    if (!wakesExisted)
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO broker_wake (run_id, updated_at) SELECT run_id, MAX(updated_at) FROM broker_command WHERE json_extract(request_json, '$.protocolVersion') < 3 AND updated_at > ? GROUP BY run_id",
        Date.now() - 25 * 60 * 60_000,
      );
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS broker_notification (run_id TEXT PRIMARY KEY, summary_json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    const recipientsExisted =
      this.storage.sql
        .exec(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'broker_run_device'",
        )
        .toArray().length > 0;
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS broker_run_device (run_id TEXT NOT NULL, device_id TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (run_id, device_id))",
    );
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS broker_command_device (request_id TEXT NOT NULL, run_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (request_id, device_id))",
    );
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS broker_legacy_run (run_id TEXT PRIMARY KEY)",
    );
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS broker_retired_run (run_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, legacy_unknown INTEGER NOT NULL, retired_at INTEGER NOT NULL)",
    );
    // Historic payload delivery did not record the receiving device. A new
    // Mac cannot certify deletion of those offline replay caches.
    if (!recipientsExisted) {
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO broker_legacy_run (run_id) SELECT run_id FROM broker_command WHERE state != 'pending' UNION SELECT run_id FROM broker_notification",
      );
    }
  }

  isRetired(runId: string): boolean {
    return (
      this.storage.sql
        .exec("SELECT 1 FROM broker_retired_run WHERE run_id = ?", runId)
        .toArray().length > 0
    );
  }

  /** Persist recipient identity before send; a crash may overcount, never miss delivered bytes. */
  recordDelivery(requestId: string, deviceId: string): void {
    const row = this.storage.sql
      .exec<{ run_id: string }>(
        "SELECT run_id FROM broker_command WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];
    if (!row || this.isRetired(row.run_id))
      throw new Error("Browser command is absent or retired");
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT OR IGNORE INTO broker_command_device (request_id, run_id, device_id) VALUES (?, ?, ?)",
        requestId,
        row.run_id,
        deviceId,
      );
      this.recordRunDelivery(row.run_id, deviceId);
    });
  }

  /** Completion notices can also hold generated text in native replay storage. */
  recordRunDelivery(runId: string, deviceId: string): void {
    if (this.isRetired(runId)) throw new Error("Browser Run is retired");
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO broker_run_device (run_id, device_id) VALUES (?, ?)",
      runId,
      deviceId,
    );
  }

  forgetRun(runId: string, receiptId: string) {
    this.storage.transactionSync(() => {
      const existing = this.storage.sql
        .exec<{ receipt_id: string }>(
          "SELECT receipt_id FROM broker_retired_run WHERE run_id = ?",
          runId,
        )
        .toArray()[0];
      // Independently authorized source receipts can depend on the same Run
      // disposal. Keep its first receipt, device acknowledgements and unknown
      // legacy recipients intact; later callers cannot reset physical erasure.
      if (!existing) {
        const unknown =
          this.storage.sql
            .exec(
              "SELECT 1 FROM broker_legacy_run WHERE run_id = ? UNION SELECT 1 FROM broker_command c WHERE c.run_id = ? AND c.state IN ('sent','completed') AND NOT EXISTS (SELECT 1 FROM broker_command_device d WHERE d.request_id = c.request_id) LIMIT 1",
              runId,
              runId,
            )
            .toArray().length > 0;
        this.storage.sql.exec(
          "INSERT INTO broker_retired_run (run_id, receipt_id, legacy_unknown, retired_at) VALUES (?, ?, ?, ?)",
          runId,
          receiptId,
          unknown ? 1 : 0,
          Date.now(),
        );
      }
      this.storage.sql.exec(
        "DELETE FROM broker_command WHERE run_id = ?",
        runId,
      );
      this.storage.sql.exec("DELETE FROM broker_wake WHERE run_id = ?", runId);
      this.storage.sql.exec(
        "DELETE FROM broker_notification WHERE run_id = ?",
        runId,
      );
      this.storage.sql.exec(
        "DELETE FROM broker_legacy_run WHERE run_id = ?",
        runId,
      );
    });
    const [row] = this.storage.sql
      .exec<{ legacy_unknown: number; outstanding: number }>(
        "SELECT legacy_unknown, (SELECT COUNT(*) FROM broker_run_device WHERE run_id = ? AND acknowledged = 0) AS outstanding FROM broker_retired_run WHERE run_id = ?",
        runId,
        runId,
      )
      .toArray();
    return { forgotten: row?.legacy_unknown === 0 && row.outstanding === 0 };
  }

  pendingForgets(
    deviceId: string,
  ): Array<{ runId: string; receiptId: string }> {
    return this.storage.sql
      .exec<{ run_id: string; receipt_id: string }>(
        "SELECT r.run_id, r.receipt_id FROM broker_retired_run r JOIN broker_run_device d ON d.run_id = r.run_id WHERE d.device_id = ? AND d.acknowledged = 0 ORDER BY r.retired_at, r.run_id",
        deviceId,
      )
      .toArray()
      .map((row) => ({ runId: row.run_id, receiptId: row.receipt_id }));
  }

  acknowledgeForget(runId: string, receiptId: string, deviceId: string): void {
    this.storage.sql.exec(
      "UPDATE broker_run_device SET acknowledged = 1 WHERE run_id = ? AND device_id = ? AND EXISTS (SELECT 1 FROM broker_retired_run r WHERE r.run_id = broker_run_device.run_id AND r.receipt_id = ?)",
      runId,
      deviceId,
      receiptId,
    );
  }

  enqueue(command: BrowserBridgeRequest): BrowserBridgeRequest {
    const parsed = browserBridgeRequest.parse(command);
    if (this.isRetired(parsed.runID))
      throw new Error("Browser Run is permanently retired");
    const existing = this.storage.sql
      .exec<{ request_json: string }>(
        "SELECT request_json FROM broker_command WHERE request_id = ? OR (run_id = ? AND operation_id = ?) LIMIT 1",
        parsed.id,
        parsed.runID,
        parsed.operationId,
      )
      .toArray()[0];
    if (existing) {
      const replay = browserBridgeRequest.parse(
        JSON.parse(existing.request_json),
      );
      if (JSON.stringify(replay) !== JSON.stringify(parsed)) {
        throw new Error("Browser operation was replayed with different input");
      }
      return replay;
    }
    const now = Date.now();
    this.storage.sql.exec(
      "INSERT INTO broker_command (request_id, operation_id, run_id, request_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
      parsed.id,
      parsed.operationId,
      parsed.runID,
      JSON.stringify(parsed),
      now,
      now,
    );
    return parsed;
  }

  nextReplayable(): BrowserBridgeRequest | null {
    const rows = this.storage.sql
      .exec<{ request_id: string; run_id: string; request_json: string }>(
        "SELECT request_id, run_id, request_json FROM broker_command WHERE state IN ('pending','sent') AND NOT EXISTS (SELECT 1 FROM broker_completed_command WHERE broker_completed_command.request_id = broker_command.request_id) ORDER BY created_at, request_id",
      )
      .toArray();
    for (const row of rows) {
      const parsed = browserBridgeRequest.safeParse(
        JSON.parse(row.request_json),
      );
      if (parsed.success) return parsed.data;
      // A command from an older protocol no current Mac can run. Its run is
      // woken so the server reads the step and stops the run for review.
      this.storage.sql.exec(
        "UPDATE broker_command SET state = 'cancelled', updated_at = ? WHERE request_id = ?",
        Date.now(),
        row.request_id,
      );
      this.rememberWake(row.run_id);
    }
    return null;
  }

  /** Remember a run whose browser step failed, for the next reconnect. */
  rememberWake(runId: string): void {
    if (this.isRetired(runId)) return;
    this.storage.sql.exec(
      "INSERT INTO broker_wake (run_id, updated_at) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET updated_at = excluded.updated_at",
      runId,
      Date.now(),
    );
  }

  /** A later step of the run went through: it is no longer stuck. */
  forgetWake(runId: string, generation?: number): void {
    if (generation === undefined)
      this.storage.sql.exec("DELETE FROM broker_wake WHERE run_id = ?", runId);
    else
      this.storage.sql.exec(
        "DELETE FROM broker_wake WHERE run_id = ? AND updated_at = ?",
        runId,
        generation,
      );
  }

  /**
   * The newest run to wake. It stays until the caller has published the wake
   * and forgets that generation, so a failed publication is retried on the
   * next reconnect and a newer failure recorded meanwhile is kept.
   */
  nextWake(): { runId: string; generation: number } | null {
    const row = this.storage.sql
      .exec<{ run_id: string; updated_at: number }>(
        "SELECT run_id, updated_at FROM broker_wake ORDER BY updated_at DESC LIMIT 1",
      )
      .toArray()[0];
    return row ? { runId: row.run_id, generation: row.updated_at } : null;
  }

  markSent(requestId: string): void {
    this.storage.sql.exec(
      "UPDATE broker_command SET state = 'sent', updated_at = ? WHERE request_id = ? AND state = 'pending'",
      Date.now(),
      requestId,
    );
  }

  claimResult(result: BrowserBridgeResult): ClaimedBrowserResult {
    const parsed = browserBridgeResult.parse(result);
    const row = this.storage.sql
      .exec<CommandRow>(
        "SELECT request_json, state, result_json FROM broker_command WHERE request_id = ?",
        parsed.commandID,
      )
      .toArray()[0];
    if (!row) return { command: null, newlyCompleted: false };
    const command = browserBridgeRequest.parse(JSON.parse(row.request_json));
    if (
      command.protocolVersion !== parsed.protocolVersion ||
      command.runID !== parsed.runID ||
      command.operationId !== parsed.operationID
    ) {
      throw new Error("Browser result does not match its durable command");
    }
    if (row.state === "completed") {
      this.recordCompletion(parsed.commandID);
      return { command, newlyCompleted: false };
    }
    if (row.state !== "pending" && row.state !== "sent") {
      return { command: null, newlyCompleted: false };
    }
    this.storage.sql.exec(
      "UPDATE broker_command SET state = 'completed', result_json = ?, updated_at = ? WHERE request_id = ? AND state IN ('pending','sent')",
      JSON.stringify(parsed),
      Date.now(),
      parsed.commandID,
    );
    this.recordCompletion(parsed.commandID);
    return { command, newlyCompleted: true };
  }

  private recordCompletion(requestId: string): void {
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO broker_completed_command (request_id, completed_at) VALUES (?, ?)",
      requestId,
      Date.now(),
    );
  }

  result(requestId: string): BrowserBridgeResult | null {
    const row = this.storage.sql
      .exec<{ result_json: string | null }>(
        "SELECT result_json FROM broker_command WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];
    if (!row?.result_json) return null;
    // A result from an older protocol is unreadable; its step is retried.
    const parsed = browserBridgeResult.safeParse(JSON.parse(row.result_json));
    return parsed.success ? parsed.data : null;
  }

  pendingCommands(
    runId: string,
  ): Array<{ requestId: string; createdAt: number }> {
    return this.storage.sql
      .exec<{ request_id: string; created_at: number }>(
        "SELECT request_id, created_at FROM broker_command WHERE run_id = ? AND state IN ('pending','sent') ORDER BY created_at ASC",
        runId,
      )
      .toArray()
      .map((row) => ({ requestId: row.request_id, createdAt: row.created_at }));
  }

  cancel(requestId: string): void {
    this.storage.sql.exec(
      "UPDATE broker_command SET state = 'cancelled', updated_at = ? WHERE request_id = ? AND state IN ('pending','sent')",
      Date.now(),
      requestId,
    );
  }

  saveRunCompletion(summary: RunCompletionSummary): void {
    if (this.isRetired(summary.runID)) return;
    const now = Date.now();
    this.storage.sql.exec(
      "INSERT INTO broker_notification (run_id, summary_json, acknowledged, created_at, updated_at) VALUES (?, ?, 0, ?, ?) ON CONFLICT(run_id) DO UPDATE SET summary_json = excluded.summary_json, updated_at = excluded.updated_at",
      summary.runID,
      JSON.stringify(summary),
      now,
      now,
    );
  }

  pendingRunCompletions(): RunCompletionSummary[] {
    return this.storage.sql
      .exec<{ summary_json: string }>(
        "SELECT summary_json FROM broker_notification WHERE acknowledged = 0 ORDER BY created_at",
      )
      .toArray()
      .map(({ summary_json }) =>
        runCompletionSummary.parse(JSON.parse(summary_json)),
      );
  }

  acknowledgeRunCompletion(runId: string): void {
    this.storage.sql.exec(
      "UPDATE broker_notification SET acknowledged = 1, updated_at = ? WHERE run_id = ?",
      Date.now(),
      runId,
    );
  }
}
