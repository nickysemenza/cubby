import { agentConversationSchema } from "@cubby/schemas/agent-conversation";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import { setCfEnv } from "~/server/cf-env";
import { run as runTable } from "~/server/db/schema";
import { callMcpTool } from "~/server/mcp/mcp-test-utils";
import { McpOperationContext } from "~/server/mcp/operation-context";
import { createMcpServer } from "~/server/mcp/server";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

// Failure modes: foreign evidence dispatch, accidental execution, lost tool
// results across pages, credential/binary exposure, and a missing service
// reported as an empty transcript. The DO is the only external seam.
describe("member Run transcript through MCP", () => {
  const ctx = withTestDb("mcp");
  afterEach(() => setCfEnv());

  it("pages retained terminal evidence without execution and refuses foreign ownership before dispatch", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic transcript owner",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const owned = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic actor",
      actorEmail: "actor@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      trigger: "manual",
      agentSessionId: "synthetic-transcript",
      purpose: "mail_import",
      status: "completed",
      endedAt: new Date(),
    });
    const foreignParty = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic other member",
      kind: "member",
    });
    const foreign = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: foreignParty.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic actor",
      actorEmail: "actor@example.test",
      actorLedgerPartyShortcode: foreignParty.shortcode,
      actorLedgerPartyName: foreignParty.name,
      actorLedgerPartyKind: foreignParty.kind,
      trigger: "manual",
      agentSessionId: "synthetic-other-transcript",
      purpose: "mail_import",
      status: "completed",
      endedAt: new Date(),
    });
    const before = await getDb(ctx.db).select().from(runTable);
    const snapshot = agentConversationSchema.parse({
      status: "idle",
      messages: [
        {
          id: "message-1",
          role: "assistant",
          purpose: "coordinator",
          display: "Synthetic timestamp",
          createdAt: "2026-01-01T00:00:00Z",
          parts: [
            {
              type: "tool",
              toolCallId: "call-1",
              toolName: "claim_next_import_work",
              state: "output-available",
              input: { operationId: "repeated" },
              output: {
                kind: "none",
                token: "synthetic-secret",
                image: "data:image/png;base64,AAAA",
              },
              durationMs: 12,
            },
          ],
        },
        {
          id: "message-2",
          role: "assistant",
          purpose: "coordinator",
          display: "Synthetic timestamp",
          createdAt: "2026-01-01T00:00:01Z",
          parts: [{ type: "text", text: "All admitted work settled." }],
        },
      ],
      settlements: [{ operationId: "submission-1", outcome: "done" }],
    });
    const dispatched: Request[] = [];
    setCfEnv(
      fromPartial<Env>({
        PURCHASE_IMPORT_RUN: {
          getByName: () =>
            fromPartial({
              fetch: async (request: Request) => {
                dispatched.push(request);
                return Response.json(snapshot);
              },
            }),
        },
      }),
    );
    const operationContext = new McpOperationContext(
      requireActor(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      ),
    );
    const read = (runId: string, cursor?: number) =>
      callMcpTool(
        createMcpServer(),
        "imports_read",
        { action: "run_transcript", runId, limit: 1, cursor },
        {},
        { operationContext },
      );
    const first = await read(owned.shortcode);
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toMatchObject({
      status: "idle",
      nextCursor: 1,
      messages: [
        {
          id: "message-1",
          parts: [
            {
              input: { operationId: "repeated" },
              output: {
                kind: "none",
                token: "[redacted]",
                image: "[binary omitted]",
              },
            },
          ],
        },
      ],
      settlements: [{ outcome: "done" }],
    });
    const second = await read(owned.shortcode, 1);
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent).toMatchObject({
      messages: [{ id: "message-2" }],
      settlements: [],
      nextCursor: null,
    });
    expect((await read(foreign.shortcode)).isError).toBe(true);
    expect(dispatched).toHaveLength(2);
    for (const request of dispatched) {
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/transcript");
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
    }
    expect(await getDb(ctx.db).select().from(runTable)).toEqual(before);
    setCfEnv();
    expect((await read(owned.shortcode)).isError).toBe(true);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runTable)
        .where(eq(runTable.id, owned.id)),
    ).toHaveLength(1);
  });
});
