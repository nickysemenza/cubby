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
  // coordinator behind it; it fails with its class, the harness's own reason
  // and the last recorded error.
  it("fails the run on any other unanswered outcome, keeping pi's reason and error", () => {
    expect(
      settlementReport(
        {
          operationId: "op-1",
          session: "1",
          status: "unanswered",
          reason: "model_error",
        },
        "503 upstream connect error",
      ),
    ).toEqual({
      kind: "fail",
      failureCode: "agent_transient",
      detail:
        "Coordinator transient failure (model_error): 503 upstream connect error",
    });
  });

  // Only a transient class retries automatically: a deterministic failure
  // retried at Run scope re-spends a coordinator on the same refusal.
  it.each([
    ["model_error", "429 Too Many Requests", "agent_transient"],
    ["model_error", "AI gateway egress deadline exceeded", "agent_transient"],
    ["model_error", "Request status code: 502", "agent_transient"],
    // An admission database fault without a SQLSTATE (2026-11-09).
    [
      "model_error",
      'OpenAI API error (502): {"type":"cubby_transport_failed","message":"Admission database fault: Failed query: select 1"}',
      "agent_transient",
    ],
    ["faulted", "Connection terminated unexpectedly", "agent_transient"],
    ["stale", undefined, "agent_transient"],
    ["reset", undefined, "agent_transient"],
    ["restart_limit", undefined, "agent_transient"],
    ["interrupted", undefined, "agent_transient"],
    ["model_error", undefined, "agent_failed"],
    [
      "faulted",
      "import_extracted_order: orders.0.lines.2.total: expected 500, got 50",
      "agent_failed",
    ],
    ["model_error", "403 Forbidden: invalid API key", "agent_failed"],
    ["model_error", "HTTP 403: network access denied", "agent_failed"],
    ["stale", "401 Unauthorized: gateway timeout", "agent_failed"],
  ] as const)("classifies %s with %j as %s", (reason, lastError, code) => {
    expect(
      settlementReport(
        { operationId: "op-1", session: "1", status: "unanswered", reason },
        lastError,
      ),
    ).toMatchObject({ kind: "fail", failureCode: code });
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
    fundingUnavailableFor?: string;
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
        progressStamp: () => ({
          generation: "synthetic-generation",
          sequence: 1,
        }),
        receivedEventIds: () => ["event-1"],
        reviewDetail: () => input.reviewDetail,
        fundingUnavailable: (operationId: string) =>
          operationId === input.fundingUnavailableFor,
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
          generation: "synthetic-generation",
          sequence: 1,
          receivedEventIds: ["event-1"],
          detail: "Research generation limit (256) reached.",
        },
      ]);
    },
  );
  it("reports a funding stop only for the submission whose own turn found it", async () => {
    const stopped = setup({
      pending: [],
      latest: "newest",
      reason: "model_error",
      fundingUnavailableFor: "newest",
    });
    await stopped.settle("newest");
    expect(stopped.reports[0]).toMatchObject({ fundingUnavailable: true });

    // A resumed submission that fails before any model turn stays a failure.
    const resumed = setup({
      pending: [],
      latest: "newest",
      reason: "model_error",
      fundingUnavailableFor: "earlier",
    });
    await resumed.settle("newest");
    expect(resumed.reports[0]).toMatchObject({
      failure: { failureCode: "agent_failed" },
    });
    expect(resumed.reports[0]).not.toHaveProperty("fundingUnavailable");
  });

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
        generation: "synthetic-generation",
        sequence: 1,
        receivedEventIds: ["event-1"],
        failure: {
          failureCode: "agent_aborted",
          detail: "Coordinator aborted",
        },
      },
    ]);
  });
});
