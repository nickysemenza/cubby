import { describe, expect, it } from "vitest";

import { toolKind } from "../../../scripts/generator/start-operations/mcp-tools";

// A read-only MCP tool is auto-approvable only while every action in it
// reads; `pnpm generate` is the gate that keeps a write out of one.
describe("MCP tool generation", () => {
  it("refuses a tool that mixes query and mutation actions", () => {
    expect(() =>
      toolKind("finance_read", [
        { name: "statement_rows", kind: "query" },
        { name: "record", kind: "mutation" },
      ]),
    ).toThrow(
      "MCP tool finance_read mixes query actions (statement_rows) and mutation actions (record)",
    );
  });

  it("returns the shared kind of a homogeneous tool", () => {
    expect(
      toolKind("statement_rows", [
        { name: "record", kind: "mutation" },
        { name: "delete", kind: "mutation" },
      ]),
    ).toBe("mutation");
  });
});
