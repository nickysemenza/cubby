import type { SqlStorage } from "@cloudflare/workers-types";
import type { AgentModelUsage } from "@cubby/schemas/agent-conversation";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { z } from "zod";

// Reads pi's `pi.usage` documents in place, like the retained transcript
// reader: the table layout below is pi SQLite schema 1 behind the Agents
// adapter's pi_ prefix, so an upgraded pi fails here instead of misreading.
const SUPPORTED_PI_SQLITE_SCHEMA_VERSION = 1;

const usageState = z.object({
  models: z.record(
    z.string(),
    z.object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
  ),
});

/** pi's token totals per `provider/model`, summed over every conversation. */
export function readPiModelUsage(sql: SqlStorage): AgentModelUsage[] {
  if (CURRENT_SQLITE_SCHEMA_VERSION !== SUPPORTED_PI_SQLITE_SCHEMA_VERSION)
    throw new Error(
      `Installed pi SQLite schema ${CURRENT_SQLITE_SCHEMA_VERSION}; model usage reader supports ${SUPPORTED_PI_SQLITE_SCHEMA_VERSION}`,
    );
  // A store pi never wrote a document to has nothing to total.
  if (
    !sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_documents'",
      )
      .toArray().length
  )
    return [];
  // `pi.usage` checkpoints every write, so a live document's newest revision
  // is a whole base value.
  const rows = sql
    .exec<{ document_id: number; kind: string; content: string }>(
      `SELECT r.document_id, r.kind, r.content
       FROM pi_documents d
       JOIN pi_document_revisions r ON r.document_id = d.id
       WHERE json_extract(d.record, '$.kind') = 'pi.usage' AND d.retired_at IS NULL
         AND r.seq = (SELECT max(seq) FROM pi_document_revisions WHERE document_id = d.id)`,
    )
    .toArray();
  const totals = new Map<string, AgentModelUsage>();
  for (const row of rows) {
    if (row.kind !== "base")
      throw new Error(
        `pi.usage document ${row.document_id} ends in a ${row.kind} revision`,
      );
    const state = usageState.parse(JSON.parse(row.content));
    for (const [model, usage] of Object.entries(state.models)) {
      const total = totals.get(model) ?? {
        model,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      total.inputTokens += usage.input;
      total.outputTokens += usage.output;
      total.cacheReadTokens += usage.cacheRead;
      total.cacheWriteTokens += usage.cacheWrite;
      totals.set(model, total);
    }
  }
  return [...totals.values()].sort((a, b) => a.model.localeCompare(b.model));
}
