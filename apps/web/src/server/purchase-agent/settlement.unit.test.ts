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
    reason?: string;
    status?: "done" | "unanswered";
    reviewDetail?: string;
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
          status: input.status ?? ("unanswered" as const),
          reason:
            input.status === "done" ? undefined : (input.reason ?? "aborted"),
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
        reviewDetail: () => input.reviewDetail,
      },
      onSettled: () => undefined,
      report: () => undefined,
    };
    return {
      reports,
      settle: (operationId: string) => reportSettlement(deps, operationId),
    };
  };

  // PiHarness drops hook exception details; a persisted research budget stop
  // must reach ordinary unfinished-work review rather than generic failure.
  it.each([
    { status: "done" as const, reason: undefined },
    { status: "unanswered" as const, reason: "faulted" },
    { status: "unanswered" as const, reason: "model_error" },
  ])(
    "reconciles a durable generation limit behind a $status/$reason operation receipt with its retained reason",
    async ({ status, reason }) => {
      const { reports, settle } = setup({
        pending: [],
        latest: "newest",
        reason,
        status,
        reviewDetail: "Research generation limit (256) reached.",
      });
      expect(await settle("newest")).toBe("done");
      expect(reports).toEqual([
        {
          operationId: "submission-settled:newest",
          receivedEventIds: ["event-1"],
          detail: "Research generation limit (256) reached.",
        },
      ]);
    },
  );
  it("preserves an explicit abort even when a previous generation limit is retained", async () => {
    const { reports, settle } = setup({
      pending: [],
      latest: "newest",
      reason: "aborted",
      reviewDetail: "Research generation limit (256) reached.",
    });
    expect(await settle("newest")).toBe("done");
    expect(reports[0]).toMatchObject({
      failure: { failureCode: "agent_aborted" },
    });
  });
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
