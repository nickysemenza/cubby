import { agentConversationSchema } from "@cubby/schemas/agent-conversation";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";
import { fromAny } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { projectConversation } from "./conversation";

const usage = {
  input: 120,
  output: 30,
  cacheRead: 100,
  cacheWrite: 0,
  totalTokens: 150,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
};

// pi brands its numeric ids at storage boundaries; fixtures stand in.
const entryId = (value: number) => fromAny<EntryId, number>(value);
const root = fromAny<ConversationId, number>(1);

const entries: EntryRecord[] = [
  {
    id: entryId(1),
    conversationId: root,
    kind: "pi.user",
    model: [
      {
        role: "user",
        content:
          '<signal type="purchase-import.start_or_resume" eventId="ev-1">{"runId":"PIR-4K7M"}</signal>',
        timestamp: Date.parse("2026-10-04T10:00:00Z"),
      },
    ],
  },
  {
    id: entryId(2),
    conversationId: root,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-6-sol",
        responseId: "resp-1",
        usage,
        stopReason: "toolUse",
        timestamp: Date.parse("2026-10-04T10:00:01Z"),
        content: [
          { type: "thinking", thinking: "Claim work first." },
          {
            type: "toolCall",
            id: "call-1",
            name: "claim_next_import_work",
            arguments: { operationId: "claim-1" },
          },
          {
            type: "toolCall",
            id: "call-2",
            name: "mcp__cubby__purchase_import",
            arguments: { action: "prepare" },
          },
        ],
      },
    ],
  },
  {
    id: entryId(3),
    conversationId: root,
    kind: "pi.tool-result",
    data: { diagnostics: [] },
    model: [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "claim_next_import_work",
        content: [{ type: "text", text: '{"kind":"order"}' }],
        isError: false,
        timestamp: Date.parse("2026-10-04T10:00:03Z"),
      },
    ],
  },
  {
    id: entryId(4),
    conversationId: root,
    kind: "pi.user",
    model: [
      {
        role: "user",
        content: "Skip the second order.",
        timestamp: Date.parse("2026-10-04T10:00:04Z"),
      },
    ],
  },
];

describe("projectConversation", () => {
  it.each([false, true])(
    "shows failed model diagnostics without credentials (live=%s)",
    (live) => {
      const failure: AssistantMessage = {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-6-sol",
        usage,
        stopReason: "error",
        errorMessage:
          "HTTP 429: quota exceeded\nAuthorization: Bearer synthetic-secret",
        timestamp: Date.parse("2026-10-04T10:00:01Z"),
        content: live ? [{ type: "text", text: "Research started." }] : [],
      };
      const result = projectConversation({
        entries: live
          ? []
          : [
              {
                id: entryId(5),
                conversationId: root,
                kind: "pi.assistant",
                model: [failure],
              },
            ],
        partial: live ? failure : undefined,
        running: live,
        settlements: [],
        contextCalls: new Map(),
      });
      expect(result.messages[0]?.parts).toEqual([
        ...(live ? [{ type: "text", text: "Research started." }] : []),
        {
          type: "text",
          text: "HTTP 429: quota exceeded\nAuthorization: [REDACTED]",
        },
      ]);
    },
  );

  const projected = projectConversation({
    entries,
    running: true,
    settlements: [{ operationId: "op-0", outcome: "done" }],
    contextCalls: new Map([
      [
        "resp-1",
        {
          v: 1,
          calls: [
            {
              inputTokens: 120,
              cachedTokens: 100,
              estimated: false,
              sections: {
                instructions: 20,
                agentToolSchemas: 40,
                mcpToolSchemas: 20,
                conversation: 40,
                toolResults: {},
              },
            },
          ],
        },
      ],
    ]),
  });

  it("satisfies the shared contract the web app parses", () => {
    expect(agentConversationSchema.parse(projected)).toEqual(projected);
    expect(projected.status).toBe("running");
  });

  it("shows queue events as signal rows and member text as user rows", () => {
    const [signal, , member] = projected.messages.map((message) => message);
    if (!signal || !member) throw new Error("expected three rows");
    expect(signal.role).toBe("signal");
    expect(signal.signal).toEqual({
      type: "purchase-import.start_or_resume",
      attributes: { eventId: "ev-1" },
    });
    expect(member.role).toBe("user");
    expect(member.parts).toEqual([
      { type: "text", text: "Skip the second order." },
    ]);
  });

  // The run page's work summary counts tool parts by state; a call without a
  // result yet must stay running rather than read as completed.
  it("joins tool results onto their calls and leaves unanswered calls running", () => {
    const assistant = projected.messages[1];
    if (!assistant) throw new Error("expected an assistant row");
    expect(assistant.parts[0]).toEqual({
      type: "reasoning",
      text: "Claim work first.",
    });
    expect(assistant.parts[1]).toMatchObject({
      type: "tool",
      toolName: "claim_next_import_work",
      state: "output-available",
      output: { kind: "order" },
      durationMs: 2_000,
    });
    expect(assistant.parts[2]).toMatchObject({
      type: "tool",
      toolName: "mcp__cubby__purchase_import",
      state: "input-available",
    });
    expect(assistant.metadata?.contextBreakdown?.calls).toHaveLength(1);
    expect(assistant.metadata?.usage?.cacheReadTokens).toBe(100);
  });
});
