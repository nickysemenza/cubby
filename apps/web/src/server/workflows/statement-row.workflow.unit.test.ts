import { describe, expect, it } from "vitest";

import { startOperationDefinitionFor } from "~/lib/start-operation-observability";

import {
  deleteStatementRowsWorkflow,
  findStatementRowDriftWorkflow,
  getStatementRowSummaryWorkflow,
  listStatementImportsWorkflow,
  listStatementRowsWorkflow,
  recordStatementRowsWorkflow,
  updateStatementRowsWorkflow,
} from "./statement-row.server";

describe("statement-row workflow ownership", () => {
  it("registers browser reads under their public operation identities", () => {
    for (const operation of [
      listStatementRowsWorkflow,
      getStatementRowSummaryWorkflow,
      listStatementImportsWorkflow,
    ]) {
      expect(
        startOperationDefinitionFor(operation.definition.name),
      ).toBeDefined();
    }
  });

  it("keeps the MCP-only drift read on its stable workflow identity", () => {
    expect(findStatementRowDriftWorkflow.definition.name).toBe(
      "statementRow.drift",
    );
  });

  it("exposes statement-row writes under stable workflow identities", () => {
    expect(recordStatementRowsWorkflow.definition.name).toBe(
      "statementRow.record",
    );
    expect(updateStatementRowsWorkflow.definition.name).toBe(
      "statementRow.update",
    );
    expect(deleteStatementRowsWorkflow.definition.name).toBe(
      "statementRow.delete",
    );
  });

  it("keeps record previews outside committed workflow steps", () => {
    expect(recordStatementRowsWorkflow.definition.steps[0]).toMatchObject({
      type: "branch",
      name: "result",
    });
    const branch = recordStatementRowsWorkflow.definition.steps[0];
    if (branch?.type !== "branch") throw new Error("Expected result branch");
    expect(branch.whenFalse.steps[0]).toMatchObject({ type: "call" });
    expect(branch.whenTrue.steps[0]).toMatchObject({
      type: "committedCall",
    });
  });
});
