import type { reconcileSettledRunInput } from "@cubby/schemas/purchase-agent-services";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { reportSettlement, settlementReport } from "./settlement";

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

// Regression: aborting settles queued newer work first while older work
// unwinds; dropping the newest report then lost every report for the run.
describe("reportSettlement", () => {
  const setup = (input: {
    pending: Array<{ operationId: string }>;
    latest: string;
  }) => {
    const reports: Array<z.input<typeof reconcileSettledRunInput>> = [];
    const deps = {
      harness: {
        pending: async () =>
          input.pending.map(({ operationId }) => ({
            operationId,
            session: "1",
            status: "running" as const,
          })),
        wait: async (operationId: string) => ({
          operationId,
          session: "1",
          status: "unanswered" as const,
          reason: "aborted",
        }),
      },
      services: {
        reconcileSettledRun: async (
          report: z.input<typeof reconcileSettledRunInput>,
        ) => {
          reports.push(report);
          return { reconciled: false, status: "running" };
        },
        updateAgentProgress: async () => ({ recorded: true }),
      },
      submissions: {
        latest: () => input.latest,
        receivedEventIds: () => ["event-1"],
      },
      onSettled: () => undefined,
      report: () => undefined,
    };
    return {
      reports,
      settle: (operationId: string) => reportSettlement(deps, operationId),
    };
  };

  it("waits to report the newest settlement while older work is pending", async () => {
    const { reports, settle } = setup({
      pending: [{ operationId: "older" }],
      latest: "newest",
    });
    expect(await settle("newest")).toBe("retry");
    expect(reports).toEqual([]);
  });

  it("drops a superseded settlement and reports the newest once idle, failures behind the same fence", async () => {
    const { reports, settle } = setup({ pending: [], latest: "newest" });
    expect(await settle("older")).toBe("done");
    expect(reports).toEqual([]);
    expect(await settle("newest")).toBe("done");
    expect(reports).toEqual([
      {
        operationId: "submission-settled:newest",
        receivedEventIds: ["event-1"],
        failure: {
          failureCode: "agent_aborted",
          detail: "Coordinator aborted",
        },
      },
    ]);
  });
});
