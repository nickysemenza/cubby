import type { AgentConversationMessage } from "@cubby/schemas/agent-conversation";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import { AgentTranscript } from "./agent-transcript";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => harness.dispose());

const assistant = (
  id: string,
  parts: AgentConversationMessage["parts"],
): AgentConversationMessage => ({
  id,
  role: "assistant",
  purpose: "coordinator",
  display: "16:01",
  createdAt: "2026-09-20T16:01:00.000Z",
  metadata: {
    model: "fixture-model",
    usage: {
      inputTokens: 12_400,
      outputTokens: 380,
      cacheReadTokens: 9_100,
      cacheWriteTokens: 0,
    },
  },
  parts,
});

const messages: AgentConversationMessage[] = [
  assistant("m1", [
    { type: "text", text: "Reading the **order** first." },
    {
      type: "tool",
      toolCallId: "call-search",
      toolName: "mcp__cubby__search",
      state: "output-available",
      input: { action: "global", query: "olive oil" },
      output: {
        results: [
          {
            id: "PRD-4K7M",
            entityKind: "product",
            title: "Fixture olive oil",
            subtitle: null,
          },
        ],
        related: [],
        relatedStatus: "not_requested",
      },
      durationMs: 240,
    },
    {
      type: "tool",
      toolCallId: "call-commit",
      toolName: "mcp__cubby__purchase_import",
      state: "output-error",
      input: { action: "commit", prepareOperationId: "prepare-1" },
      errorText: "Fixture commit conflict",
    },
    {
      type: "tool",
      toolCallId: "call-other",
      toolName: "mcp__cubby__imports_read",
      state: "output-available",
      input: { action: "purchase_status", operationId: "extract-1" },
      output: { state: "completed" },
    },
  ]),
];

// The transcript is the agent section's body: a tool call is one summarized
// line, a failure opens itself, settlements sit beside the call that names
// their operation, and a registered renderer replaces the JSON payloads.
it("renders tool calls as summarized steps with inline settlements", () => {
  render(
    <AgentTranscript
      messages={messages}
      live={false}
      settlements={[
        { operationId: "extract-1", outcome: "done" },
        { operationId: "orphan-1", outcome: "unanswered", reason: "No reply" },
      ]}
    />,
    { wrapper: harness.wrapper },
  );

  const transcript = screen.getByLabelText("Agent conversation transcript");
  expect(within(transcript).getByText("order")).toBeInTheDocument();
  expect(
    screen.getByText("fixture-model · 12.4K in · 380 out · 9.1K cached", {
      exact: false,
    }),
  ).toBeInTheDocument();

  const search = screen.getByRole("button", { name: /search\.global/u });
  expect(search).toHaveTextContent('"olive oil" · 1 result');
  expect(search).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(search);
  expect(screen.getByRole("list", { name: "Records" })).toHaveTextContent(
    "Fixture olive oil",
  );
  expect(screen.queryByText("Result")).not.toBeInTheDocument();

  const commit = screen.getByRole("button", {
    name: /purchase_import\.commit/u,
  });
  expect(commit).toHaveAttribute("aria-expanded", "true");
  expect(screen.getAllByText("Fixture commit conflict").length).toBeGreaterThan(
    0,
  );

  const status = screen.getByRole("button", {
    name: /imports_read\.purchase_status/u,
  });
  expect(status).toHaveTextContent('operationId="extract-1"');
  const settled = screen.getByText("Settled extract-1");
  expect(
    status.compareDocumentPosition(settled) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(screen.getByText("Settled orphan-1")).toBeInTheDocument();
  expect(screen.getByText("No reply")).toBeInTheDocument();
});
