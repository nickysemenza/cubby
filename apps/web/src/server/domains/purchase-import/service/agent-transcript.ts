import type { SqlStorage } from "@cloudflare/workers-types";
import {
  agentConversationSchema,
  agentConversationSettlementSchema,
} from "@cubby/schemas/agent-conversation";
import {
  contextBreakdownSchema,
  type ContextBreakdown,
} from "@cubby/schemas/context-breakdown";
import {
  ROOT_CONVERSATION_ID,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { z } from "zod";

import { projectConversation } from "~/server/domains/purchase-agent/service/conversation";

// The installed Agents adapter prefixes pi's portable SQLite tables with pi_.
// Keep this read adapter version-fenced; never open/migrate storage or construct
// the execution Agent to inspect it. PiHarness.open resumes pending tasks.
const SUPPORTED_PI_SQLITE_SCHEMA_VERSION = 1;
const storedEntryFields = z.object({
  id: z.number().int().positive(),
  conversationId: z.number().int().positive(),
  kind: z.string(),
  model: z
    .array(
      z.looseObject({
        role: z.enum(["user", "assistant", "toolResult", "system"]),
        content: z.union([z.string(), z.array(z.json())]),
      }),
    )
    .optional(),
});
const storedEntry = z.custom<EntryRecord>(
  (value) => storedEntryFields.safeParse(value).success,
);

/** Committed transcript only; live generation partials stay on the live UI. */
export function readStoredAgentConversation(sql: SqlStorage) {
  const tables = new Set(
    sql
      .exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .toArray()
      .map((row) => row.name),
  );
  if (!tables.has("pi_durable_schema") && !tables.has("pi_conversations"))
    return agentConversationSchema.parse({
      status: "absent",
      messages: [],
      settlements: [],
    });
  const [schema] = sql
    .exec<{ version: number }>(
      "SELECT version FROM pi_durable_schema WHERE singleton = 1",
    )
    .toArray();
  if (
    CURRENT_SQLITE_SCHEMA_VERSION !== SUPPORTED_PI_SQLITE_SCHEMA_VERSION ||
    schema?.version !== SUPPORTED_PI_SQLITE_SCHEMA_VERSION
  )
    throw new Error(
      `Retained pi SQLite schema ${schema?.version}, installed schema ${CURRENT_SQLITE_SCHEMA_VERSION}; transcript adapter supports ${SUPPORTED_PI_SQLITE_SCHEMA_VERSION}`,
    );
  const present =
    sql
      .exec("SELECT 1 FROM pi_conversations WHERE id = ?", ROOT_CONVERSATION_ID)
      .toArray().length > 0;
  if (!present)
    return agentConversationSchema.parse({
      status: "absent",
      messages: [],
      settlements: [],
    });
  const entries = sql
    .exec<{ record: string }>(
      "SELECT record FROM pi_entries WHERE conversation_id = ? ORDER BY id",
      ROOT_CONVERSATION_ID,
    )
    .toArray()
    .map((row) => storedEntry.parse(JSON.parse(row.record)));
  const running =
    sql
      .exec(
        "SELECT 1 FROM pi_tasks WHERE conversation_id = ? AND status <> 'terminal' LIMIT 1",
        ROOT_CONVERSATION_ID,
      )
      .toArray().length > 0;
  const contextCalls = new Map<string, ContextBreakdown>();
  if (tables.has("cubby_context_calls")) {
    for (const row of sql
      .exec<{ response_id: string; breakdown: string }>(
        "SELECT response_id, breakdown FROM cubby_context_calls",
      )
      .toArray()) {
      contextCalls.set(
        row.response_id,
        contextBreakdownSchema.parse(JSON.parse(row.breakdown)),
      );
    }
  }
  const settlements = tables.has("cubby_settlements")
    ? sql
        .exec<{ operation_id: string; outcome: string; reason: string | null }>(
          "SELECT operation_id, outcome, reason FROM cubby_settlements ORDER BY rowid",
        )
        .toArray()
        .map((row) =>
          agentConversationSettlementSchema.parse({
            operationId: row.operation_id,
            outcome: row.outcome,
            reason: row.reason ?? undefined,
          }),
        )
    : [];
  return agentConversationSchema.parse(
    projectConversation({ entries, running, settlements, contextCalls }),
  );
}
