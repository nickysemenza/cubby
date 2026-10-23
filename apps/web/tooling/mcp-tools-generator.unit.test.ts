import { describe, expect, it } from "vitest";

import {
  assertMcpExposure,
  toolKind,
} from "../generator/start-operations/mcp-tools";

describe("MCP tool generation", () => {
  it("marks a grouped tool read-only only when all actions are queries", () => {
    expect(
      toolKind("finance", [
        { name: "summary", kind: "query" },
        { name: "record", kind: "mutation" },
      ]),
    ).toBe("mutation");
    expect(toolKind("entity_read", [{ name: "get", kind: "query" }])).toBe(
      "query",
    );
  });
});

describe("operation exposure declarations", () => {
  it("accepts capability, view, internal, and subscription operations", () => {
    expect(() =>
      assertMcpExposure({
        operations: [
          {
            operation: "widget.list",
            kind: "query",
            exposure: "capability",
            description: "List household widgets.",
          },
          { operation: "widget.board", kind: "query", exposure: "view" },
          {
            operation: "widget.companion",
            kind: "mutation",
            exposure: "internal",
          },
          { operation: "widget.events", kind: "subscription" },
        ],
      }),
    ).not.toThrow();
  });

  it("fails generation when a capability member has no description", () => {
    expect(() =>
      assertMcpExposure({
        operations: [
          {
            operation: "widget.archive",
            kind: "mutation",
            exposure: "capability",
          },
        ],
      }),
    ).toThrow(
      "widget.archive is a capability but has no agent-facing description",
    );
  });

  it("requires each query and mutation to resolve an exposure kind", () => {
    expect(() =>
      assertMcpExposure({
        operations: [{ operation: "widget.archive", kind: "mutation" }],
      }),
    ).toThrow("widget.archive must declare an exposure kind");
  });
});
