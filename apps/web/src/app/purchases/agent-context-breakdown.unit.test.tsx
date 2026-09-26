import type { FlueConversationMessage } from "@flue/sdk";
import { render, screen, within } from "@testing-library/react";
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

const message = (
  id: string,
  submissionId: string,
  metadata?: FlueConversationMessage["metadata"],
) =>
  fromPartial<FlueConversationMessage>({
    id,
    role: "assistant",
    submissionId,
    parts: [],
    metadata,
  });

const messages = [
  message("m1", "s1", {
    usage: { input: 1 },
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
  // A second message of the same response must not double count.
  message("m1b", "s1", {
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
  message("m2", "s2", { contextBreakdown: { v: 2, calls: "garbage" } }),
  message("m3", "s3", {
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
      <AgentContextPerCall messages={[message("m1", "s1", { usage: {} })]} />,
    );
    expect(container.textContent).toBe("");
  });
});
