import { describe, expect, it } from "vitest";

import { recordStatementRowsWorkflow } from "./statement-row.server";

describe("statement-row workflow ownership", () => {
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
