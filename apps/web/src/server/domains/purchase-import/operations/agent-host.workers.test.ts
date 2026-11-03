import { agentConversationSchema } from "@cubby/schemas/agent-conversation";
import { importRunAgentIdentity } from "@cubby/schemas/import-run-agent";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  ROOT_CONVERSATION_ID,
  UserEntry,
  UsageDoc,
} from "@earendil-works/pi-durable";
import { openPiSessionStore } from "agents/harness/pi";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { readStoredAgentConversation } from "../service/agent-transcript";

describe("purchase agent host observation", () => {
  it("answers a cold stream from retained storage without constructing the agent", async () => {
    const stub = env.PURCHASE_IMPORT_RUN.getByName(
      importRunAgentIdentity(crypto.randomUUID(), "photo_inventory"),
    );

    const response = await stub.fetch("https://purchase-agent.internal/stream");

    expect(response.headers.get("content-type")).toContain("application/json");
    expect(agentConversationSchema.parse(await response.json())).toMatchObject({
      status: "absent",
    });
    // Constructing the agent opens pi, which resumes pending tasks; its
    // constructor leaves cubby_state behind.
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT name FROM sqlite_master WHERE name = 'cubby_state'")
          .toArray(),
      ).toEqual([]);
    });
  });

  it.each([1, 2])(
    "reads schema %s transcripts without resuming retained tasks",
    async (version) => {
      const stub = env.PURCHASE_IMPORT_RUN.getByName(
        importRunAgentIdentity(crypto.randomUUID(), "photo_inventory"),
      );
      const usage = (input: number) => ({
        input,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        totalTokens: input + 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
      await runInDurableObject(stub, async (_instance, state) => {
        const context = BACKGROUND_CONTEXT;
        const pi = await Harness.open(
          await openPiSessionStore(state.storage),
          { models: createModels(), registry: createRegistry() },
          context,
        );
        const root = await pi.root(context);
        await root.commit(async (tx) => {
          await tx.appendEntry(UserEntry, ROOT_CONVERSATION_ID, {
            model: [
              {
                role: "user",
                content: "Synthetic request",
                timestamp: 1_767_225_600_000,
              },
            ],
          });
          await tx.appendEntry(AssistantEntry, ROOT_CONVERSATION_ID, {
            model: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Synthetic answer" }],
                api: "openai-responses",
                provider: "synthetic",
                model: "turn-model",
                stopReason: "stop",
                responseId: "synthetic-response",
                usage: usage(11),
                timestamp: 1_767_225_600_001,
              },
            ],
          });
          const doc = await tx.doc(UsageDoc, ROOT_CONVERSATION_ID);
          doc.models["synthetic/turn-model"] = usage(11);
          doc.models["synthetic/summary-model"] = usage(5);
        }, context);
        await pi.close(context);
        const sql = state.storage.sql;
        if (version === 2) {
          // Upstream schema 2 rebuilds only tasks to admit sleeping checkpoints.
          // The installed schema-1 SDK cannot create this retained state.
          sql.exec(`CREATE TABLE pi_tasks_v2 (
          id INTEGER PRIMARY KEY, conversation_id INTEGER NOT NULL, kind TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
          abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
          background INTEGER NOT NULL CHECK (background IN (0, 1)),
          record TEXT NOT NULL CHECK (json_valid(record))
        ) STRICT`);
          sql.exec("INSERT INTO pi_tasks_v2 SELECT * FROM pi_tasks");
          sql.exec("DROP TABLE pi_tasks");
          sql.exec("ALTER TABLE pi_tasks_v2 RENAME TO pi_tasks");
          sql.exec(
            "UPDATE pi_durable_schema SET version = 2 WHERE singleton = 1",
          );
        }
        sql.exec(
          "INSERT INTO pi_tasks (id, conversation_id, kind, status, abort_requested, background, record) VALUES (99, ?, 'synthetic.retained', ?, 0, 0, ?)",
          ROOT_CONVERSATION_ID,
          version === 2 ? "sleeping" : "pending",
          JSON.stringify({
            checkpoint: "synthetic-checkpoint",
            arguments: { preserved: true },
          }),
        );
        sql.exec(
          "CREATE TABLE cubby_context_calls (response_id TEXT PRIMARY KEY, breakdown TEXT NOT NULL)",
        );
        sql.exec(
          "INSERT INTO cubby_context_calls VALUES ('synthetic-response', ?)",
          JSON.stringify({ v: 1, calls: [] }),
        );
        sql.exec(
          "CREATE TABLE cubby_settlements (operation_id TEXT PRIMARY KEY, outcome TEXT NOT NULL, reason TEXT)",
        );
        sql.exec(
          "INSERT INTO cubby_settlements VALUES ('synthetic-operation', 'done', NULL)",
        );
      });

      const response = await stub.fetch(
        "https://purchase-agent.internal/stream",
      );

      const conversation = agentConversationSchema.parse(await response.json());
      expect(conversation).toMatchObject({
        status: "running",
        messages: [
          {
            role: "user",
            parts: [{ type: "text", text: "Synthetic request" }],
          },
          {
            role: "assistant",
            parts: [{ type: "text", text: "Synthetic answer" }],
            metadata: { contextBreakdown: { v: 1, calls: [] } },
          },
        ],
        settlements: [{ operationId: "synthetic-operation", outcome: "done" }],
      });
      expect(conversation.modelUsage).toEqual([
        {
          model: "synthetic/summary-model",
          inputTokens: 5,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
        {
          model: "synthetic/turn-model",
          inputTokens: 11,
          outputTokens: 7,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
        },
      ]);
      await runInDurableObject(stub, (_instance, state) => {
        const sql = state.storage.sql;
        expect(
          sql
            .exec("SELECT status, record FROM pi_tasks WHERE id = 99")
            .toArray(),
        ).toEqual([
          {
            status: version === 2 ? "sleeping" : "pending",
            record: JSON.stringify({
              checkpoint: "synthetic-checkpoint",
              arguments: { preserved: true },
            }),
          },
        ]);
        expect(
          sql
            .exec("SELECT name FROM sqlite_master WHERE name = 'cubby_state'")
            .toArray(),
        ).toEqual([]);
        expect(
          sql.exec("SELECT version FROM pi_durable_schema").toArray(),
        ).toEqual([{ version }]);
        if (version !== 2) return;
        sql.exec(
          "UPDATE pi_durable_schema SET version = 3 WHERE singleton = 1",
        );
        expect(() => readStoredAgentConversation(sql)).toThrow(/schema 3/);
        expect(
          sql.exec("SELECT version FROM pi_durable_schema").toArray(),
        ).toEqual([{ version: 3 }]);
      });
    },
  );
});
