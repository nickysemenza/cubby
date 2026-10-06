import { describe, expect, it } from "vitest";

import {
  assertMcpExposure,
  toolKind,
} from "../../../scripts/generator/start-operations/mcp-tools";

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

// Every query/mutation either backs an MCP action or says why it does not,
// so a new operation cannot silently stay off the agent surface.
describe("MCP exposure declarations", () => {
  const todos =
    "- 🤔 **Deferred widget capabilities.** `widget.restock` lets an agent restock.\n";
  const check = (
    operations: Parameters<typeof assertMcpExposure>[0]["operations"],
  ) =>
    assertMcpExposure({
      operations,
      exposedOperations: new Set(["widget.list"]),
      kernelActions: new Set(["get", "update"]),
      todos,
    });

  it("accepts exposed, declared, and subscription operations", () => {
    expect(() =>
      check([
        { operation: "widget.list", kind: "query" },
        {
          operation: "widget.board",
          kind: "query",
          mcp: { omit: "client_view" },
        },
        {
          operation: "widget.detail",
          kind: "query",
          mcp: {
            omit: "kernel_alternative",
            kernel: ["get"],
            note: "entity_read.get on a widget",
          },
        },
        {
          operation: "widget.listBoard",
          kind: "query",
          mcp: { omit: "agent_twin", twin: "widget.list" },
        },
        {
          operation: "widget.restock",
          kind: "mutation",
          mcp: {
            omit: "deferred_capability",
            todo: "Deferred widget capabilities",
          },
        },
        { operation: "widget.backfill", kind: "subscription" },
      ]),
    ).not.toThrow();
  });

  it("refuses an operation that is neither exposed nor declared omitted", () => {
    expect(() =>
      check([
        { operation: "widget.list", kind: "query" },
        { operation: "widget.archive", kind: "mutation" },
      ]),
    ).toThrow(
      "widget.archive is not an MCP tool action and declares no `mcp: { omit }` reason",
    );
  });

  it("refuses an operation that is both exposed and declared omitted", () => {
    expect(() =>
      check([
        {
          operation: "widget.list",
          kind: "query",
          mcp: { omit: "client_view" },
        },
      ]),
    ).toThrow(
      "widget.list is an MCP tool action but declares `mcp: { omit: client_view }`",
    );
  });

  it("refuses an unknown omission reason", () => {
    expect(() =>
      check([
        { operation: "widget.list", kind: "query" },
        { operation: "widget.board", kind: "query", mcp: { omit: "ui_only" } },
      ]),
    ).toThrow("widget.board declares an invalid `mcp` omission");
  });

  it("refuses a kernel alternative naming a kernel action no tool exposes", () => {
    expect(() =>
      check([
        { operation: "widget.list", kind: "query" },
        {
          operation: "widget.merge",
          kind: "mutation",
          mcp: {
            omit: "kernel_alternative",
            kernel: ["merge"],
            note: "entity.merge on widgets",
          },
        },
      ]),
    ).toThrow(
      "widget.merge names kernel action merge, which no MCP tool exposes",
    );
  });

  it("refuses a kernel alternative without its explanation", () => {
    expect(() =>
      check([
        { operation: "widget.list", kind: "query" },
        {
          operation: "widget.detail",
          kind: "query",
          mcp: { omit: "kernel_alternative", kernel: ["get"] },
        },
      ]),
    ).toThrow("widget.detail declares an invalid `mcp` omission");
  });

  it("refuses an agent twin that is not itself an MCP tool action", () => {
    expect(() =>
      check([
        { operation: "widget.list", kind: "query" },
        {
          operation: "widget.board",
          kind: "query",
          mcp: { omit: "agent_twin", twin: "widget.summary" },
        },
      ]),
    ).toThrow(
      "widget.board names agent twin widget.summary, which is not an MCP tool action",
    );
  });

  it("refuses a deferred capability without its todo reference", () => {
    expect(() =>
      check([
        { operation: "widget.list", kind: "query" },
        {
          operation: "widget.restock",
          kind: "mutation",
          mcp: { omit: "deferred_capability" },
        },
      ]),
    ).toThrow("widget.restock declares an invalid `mcp` omission");
  });

  it("refuses a deferred capability whose todo is missing from docs/todos.md", () => {
    expect(() =>
      check([
        { operation: "widget.list", kind: "query" },
        {
          operation: "widget.restock",
          kind: "mutation",
          mcp: {
            omit: "deferred_capability",
            todo: "Restock widgets from agents",
          },
        },
      ]),
    ).toThrow(
      "widget.restock defers to docs/todos.md entry **Restock widgets from agents.**, which does not exist",
    );
  });

  it("refuses a deferred capability the todo entry does not list", () => {
    expect(() =>
      check([
        { operation: "widget.list", kind: "query" },
        {
          operation: "widget.recount",
          kind: "mutation",
          mcp: {
            omit: "deferred_capability",
            todo: "Deferred widget capabilities",
          },
        },
      ]),
    ).toThrow("docs/todos.md does not name `widget.recount`");
  });
});
