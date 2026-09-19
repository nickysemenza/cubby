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

export class PurchaseImportSqlStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  migrate(): void {
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS command (request_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','sent','completed','cancelled')), result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
    this.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS command_replay_idx ON command(state, created_at)",
    );
    this.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS run_state (run_id TEXT PRIMARY KEY, root_url TEXT NOT NULL, allowed_hosts_json TEXT NOT NULL, steps INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
    );
  }

  ensureRun(runId: string, rootUrl: string, allowedHosts: string[]): void {
    const now = Date.now();
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO run_state (run_id, root_url, allowed_hosts_json, steps, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)",
      runId,
      rootUrl,
      JSON.stringify(allowedHosts),
      now,
      now,
    );
  }

  advanceRun(runId: string): {
    rootUrl: string;
    allowedHosts: string[];
    steps: number;
  } | null {
    this.storage.sql.exec(
      "UPDATE run_state SET steps = steps + 1, updated_at = ? WHERE run_id = ?",
      Date.now(),
      runId,
    );
    return this.runState(runId);
  }

  runState(runId: string): {
    rootUrl: string;
    allowedHosts: string[];
    steps: number;
  } | null {
    const row = this.storage.sql
      .exec<{ root_url: string; allowed_hosts_json: string; steps: number }>(
        "SELECT root_url, allowed_hosts_json, steps FROM run_state WHERE run_id = ?",
        runId,
      )
      .toArray()[0];
    return row
      ? {
          rootUrl: row.root_url,
          allowedHosts: z
            .array(z.string())
            .parse(JSON.parse(row.allowed_hosts_json)),
          steps: row.steps,
        }
      : null;
  }

  enqueue(command: BrowserBridgeRequest): void {
    const parsed = browserBridgeRequest.parse(command);
    if (parsed.operation.type === "navigate") {
      this.ensureRun(
        parsed.runID,
        parsed.operation.url,
        parsed.operation.allowedHosts,
      );
    }
    const now = Date.now();
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO command (request_id, request_json, state, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)",
      parsed.id,
      JSON.stringify(parsed),
      now,
      now,
    );
  }

  replayable(): BrowserBridgeRequest[] {
    return this.storage.sql
      .exec<{ request_json: string }>(
        "SELECT request_json FROM command WHERE state IN ('pending','sent') ORDER BY created_at, request_id",
      )
      .toArray()
      .map(({ request_json }) =>
        browserBridgeRequest.parse(JSON.parse(request_json)),
      );
  }

  markSent(requestId: string): void {
    this.storage.sql.exec(
      "UPDATE command SET state = 'sent', updated_at = ? WHERE request_id = ? AND state = 'pending'",
      Date.now(),
      requestId,
    );
  }

  claimResult(result: BrowserBridgeResult): BrowserBridgeRequest | null {
    const parsed = browserBridgeResult.parse(result);
    const row = this.storage.sql
      .exec<CommandRow>(
        "SELECT request_json, state, result_json FROM command WHERE request_id = ?",
        parsed.commandID,
      )
      .toArray()[0];
    if (!row || (row.state !== "pending" && row.state !== "sent")) return null;
    this.storage.sql.exec(
      "UPDATE command SET state = 'completed', result_json = ?, updated_at = ? WHERE request_id = ? AND state IN ('pending','sent')",
      JSON.stringify(parsed),
      Date.now(),
      parsed.commandID,
    );
    return browserBridgeRequest.parse(JSON.parse(row.request_json));
  }

  retryResult(requestId: string): void {
    this.storage.sql.exec(
      "UPDATE command SET state = 'sent', result_json = NULL, updated_at = ? WHERE request_id = ? AND state = 'completed'",
      Date.now(),
      requestId,
    );
  }

  result(requestId: string): BrowserBridgeResult | null {
    const row = this.storage.sql
      .exec<CommandRow>(
        "SELECT request_json, state, result_json FROM command WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];
    return row?.result_json
      ? browserBridgeResult.parse(JSON.parse(row.result_json))
      : null;
  }

  command(requestId: string): BrowserBridgeRequest | null {
    const row = this.storage.sql
      .exec<{ request_json: string }>(
        "SELECT request_json FROM command WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];
    return row
      ? browserBridgeRequest.parse(JSON.parse(row.request_json))
      : null;
  }

  cancel(requestId: string): void {
    this.storage.sql.exec(
      "UPDATE command SET state = 'cancelled', updated_at = ? WHERE request_id = ? AND state IN ('pending','sent')",
      Date.now(),
      requestId,
    );
  }
}
