import { describe, expect, it } from "vitest";

import {
  assertMcpExposure,
  splitByKind,
  toolKind,
} from "../generator/operations/mcp-tools";

describe("MCP tool generation", () => {
  it("splits a contract group that mixes kinds so every read tool stays auto-approvable", () => {
    const actions = new Map([
      ["summary", { kind: "query" as const }],
      ["record", { kind: "mutation" as const }],
    ]);
    expect([...splitByKind("finance", actions)]).toEqual([
      ["finance_read", "query"],
      ["finance", "mutation"],
    ]);
    expect([...splitByKind("imports_read", actions)]).toEqual([
      ["imports_read", "query"],
      ["imports", "mutation"],
    ]);
    expect([
      ...splitByKind(
        "usda_food",
        new Map([["search", { kind: "query" as const }]]),
      ),
    ]).toEqual([["usda_food", null]]);
    expect(() =>
      toolKind("finance", [
        { name: "summary", kind: "query" },
        { name: "record", kind: "mutation" },
      ]),
    ).toThrow("mixes query actions");
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
