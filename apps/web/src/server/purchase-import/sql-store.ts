import type { DurableObjectStorage } from "@cloudflare/workers-types";
import {
  browserBridgeRequest,
  type BrowserBridgeRequest,
} from "@cubby/schemas/purchase-import";
import { z } from "zod";

import { browserBridgeResult, type BrowserBridgeResult } from "./contracts";

type CommandRow = {
  request_json: string;
  state: "pending" | "sent" | "completed" | "cancelled";
  result_json: string | null;
};

export type RunCompletionSummary = {
  runID: string;
  imported: number;
  updated: number;
  skipped: number;
  findingCount: number;
};

const runCompletionSummary = z.object({
  runID: z.string(),
  imported: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  findingCount: z.number().int().nonnegative(),
});

type ClaimedBrowserResult = {
  command: BrowserBridgeRequest | null;
  newlyCompleted: boolean;
};

/** Durable transport state only. Purchase-import orchestration lives in Flue. */
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
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS broker_notification (run_id TEXT PRIMARY KEY, summary_json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
  }

  enqueue(command: BrowserBridgeRequest): BrowserBridgeRequest {
    const parsed = browserBridgeRequest.parse(command);
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
    const row = this.storage.sql
      .exec<{ request_json: string }>(
        "SELECT request_json FROM broker_command WHERE state IN ('pending','sent') AND NOT EXISTS (SELECT 1 FROM broker_completed_command WHERE broker_completed_command.request_id = broker_command.request_id) ORDER BY created_at, request_id LIMIT 1",
      )
      .toArray()[0];
    return row
      ? browserBridgeRequest.parse(JSON.parse(row.request_json))
      : null;
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
    return row?.result_json
      ? browserBridgeResult.parse(JSON.parse(row.result_json))
      : null;
  }

  cancel(requestId: string): void {
    this.storage.sql.exec(
      "UPDATE broker_command SET state = 'cancelled', updated_at = ? WHERE request_id = ? AND state IN ('pending','sent')",
      Date.now(),
      requestId,
    );
  }

  saveRunCompletion(summary: RunCompletionSummary): void {
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
