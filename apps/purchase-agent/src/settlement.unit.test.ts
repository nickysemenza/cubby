import { describe, expect, it } from "vitest";

import { settlementReport } from "./settlement";

describe("settlementReport", () => {
  it("lets the server decide what an answered submission means for the run", () => {
    expect(
      settlementReport({ operationId: "op-1", session: "1", status: "done" }),
    ).toEqual({ kind: "reconcile" });
  });

  it("terminalizes an aborted submission as aborted", () => {
    expect(
      settlementReport({
        operationId: "op-1",
        session: "1",
        status: "unanswered",
        reason: "aborted",
      }),
    ).toEqual({
      kind: "fail",
      failureCode: "agent_aborted",
      detail: "Coordinator aborted",
    });
  });

  // A model or tool fault must not leave the run `running` with no
  // coordinator behind it; it fails with the harness's own reason.
  it("fails the run on any other unanswered outcome, keeping pi's reason", () => {
    expect(
      settlementReport({
        operationId: "op-1",
        session: "1",
        status: "unanswered",
        reason: "model_error",
      }),
    ).toEqual({
      kind: "fail",
      failureCode: "agent_failed",
      detail: "Coordinator unanswered: model_error",
    });
  });
});
