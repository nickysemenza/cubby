import type { AgentConversationMessage } from "@cubby/schemas/agent-conversation";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import { AgentContextPerCall } from "./agent-context-breakdown";

const call = (
  inputTokens: number,
  cachedTokens: number,
  sections: {
    instructions: number;
    agentToolSchemas: number;
    mcpToolSchemas: number;
    conversation: number;
    toolResults: Record<string, number>;
  },
) => ({
  model: "fixture-model",
  inputTokens,
  cachedTokens,
  estimated: false,
  sections,
});

// Fixtures intentionally include an unparseable `contextBreakdown` (wrong
// version, non-array `calls`) to exercise the schema's rejection path, so
// this names the fixture's own loose shape rather than the exact schema's.
// `AgentContextPerCall` never reads `usage`, so these fixtures don't carry
// it either.
interface MessageFixtureMetadata {
  contextBreakdown?: { v: number; calls: unknown };
}

const message = (id: string, metadata?: MessageFixtureMetadata) =>
  fromPartial<AgentConversationMessage>({
    id,
    role: "assistant",
    parts: [],
    // SAFETY: fixtures deliberately send a wrong `contextBreakdown.v` (not
    // the schema's literal `1`) to exercise the schema's own rejection path;
    // `fromPartial`'s deep-partial type can't express "any number here".
    metadata: metadata as AgentConversationMessage["metadata"],
  });

const messages = [
  message("m1", {
    contextBreakdown: {
      v: 1,
      calls: [
        call(1_000, 0, {
          instructions: 100,
          agentToolSchemas: 50,
          mcpToolSchemas: 400,
          conversation: 50,
          toolResults: {
            mcp__cubby__get_photo_run_context: 300,
            report_agent_progress: 50,
            mcp__cubby__entity: 30,
            finish_run: 20,
          },
        }),
      ],
    },
  }),
  // A duplicate entry for the same message id (a refetch racing the stream)
  // must not double count.
  message("m1", {
    contextBreakdown: {
      v: 1,
      calls: [
        call(9_999, 0, {
          instructions: 9_999,
          agentToolSchemas: 0,
          mcpToolSchemas: 0,
          conversation: 0,
          toolResults: {},
        }),
      ],
    },
  }),
  message("m2", { contextBreakdown: { v: 2, calls: "garbage" } }),
  message("m3", {
    contextBreakdown: {
      v: 1,
      calls: [
        call(2_000, 1_500, {
          instructions: 100,
          agentToolSchemas: 50,
          mcpToolSchemas: 400,
          conversation: 150,
          toolResults: {
            mcp__cubby__get_photo_run_context: 1_100,
            report_agent_progress: 100,
            mcp__cubby__entity: 60,
            finish_run: 40,
          },
        }),
      ],
    },
  }),
];

describe("AgentContextPerCall", () => {
  it("renders one stacked bar per call with every category and the top contributors", () => {
    render(<AgentContextPerCall messages={messages} />);

    const region = screen.getByRole("region", { name: "Context per call" });
    const disclosure = within(region)
      .getByText("Context per call")
      .closest("details");
    expect(disclosure?.open).toBe(false);
    fireEvent.click(within(region).getByText("Context per call"));
    expect(disclosure?.open).toBe(true);
    expect(
      within(region).getByText(
        "Top contributors across the run: get_photo_run_context results 47% · MCP tool schemas 27% · Instructions 7% · Conversation 7%",
      ),
    ).toBeTruthy();

    const legend = within(region).getByRole("list", {
      name: "Context categories",
    });
    expect(
      within(legend)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Instructions",
      "Agent tool schemas",
      "MCP tool schemas",
      "Conversation",
      "get_photo_run_context results",
      "report_agent_progress results",
      "entity results",
      "Other tool results",
    ]);

    const bars = within(region).getAllByRole("listitem", { name: /^Call / });
    expect(bars).toHaveLength(2);
    expect(bars[1]?.getAttribute("aria-label")).toContain(
      "Call 2: 2,000 input tokens, 1,500 cached",
    );
    expect(bars[1]?.getAttribute("aria-label")).toContain(
      "get_photo_run_context results 1,100",
    );

    const table = within(region).getByRole("table", {
      name: "Context per call table",
    });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(
      within(rows[2]!)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "2,000",
      "1,500",
      "100",
      "50",
      "400",
      "150",
      "1,100",
      "100",
      "60",
      "40",
    ]);
  });

  it("renders nothing for a transcript without context metadata", () => {
    const { container } = render(
      <AgentContextPerCall messages={[message("m1", {})]} />,
    );
    expect(container.textContent).toBe("");
  });
});
