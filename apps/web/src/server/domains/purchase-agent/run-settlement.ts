import type { AgentConversationSettlement } from "@cubby/schemas/agent-conversation";
import type { PiHarness } from "agents/harness/pi";
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";

import type { RunServices } from "./environment";
import { reportSettlement, type SubmissionLedger } from "./settlement";

/** Production's settlement poll; a workerd harness may shorten it. */
export const SETTLEMENT_POLL_MS = 10_000;

type SettlementJob = { operationId: string };

/**
 * One durable job per submitted operation reports its settlement to the Run
 * services. pi settles operations in memory, and this object may be evicted
 * while a run is in flight, so the report rides a Lifecycle job: its alarm
 * survives eviction, and each dispatch is bounded (check, report or
 * reschedule). Reports are idempotent by `submission-settled:<operationId>`.
 */
export class RunSettlement extends LifecycleCapability {
  constructor(
    private readonly harness: PiHarness,
    private readonly services: () => RunServices,
    private readonly report: <TError>(error: TError) => void,
    private readonly onSettled: (settled: AgentConversationSettlement) => void,
    private readonly submissions: SubmissionLedger,
    private readonly pollMs: () => number,
  ) {
    super("cubby-run-settlement");
  }

  async watch(job: SettlementJob): Promise<void> {
    // A push with an existing id replaces that job, resetting its schedule
    // and in-flight state; a redelivered submission keeps the one it has.
    if (this.lifecycle.jobs.get(`settle:${job.operationId}`)) return;
    await this.lifecycle.jobs.push({
      id: `settle:${job.operationId}`,
      fn: "settle",
      time: Date.now() + this.pollMs(),
      payload: job,
      singleflight: true,
    });
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    // SAFETY: only `watch` pushes jobs for this capability, with this payload.
    const { operationId } = job.payload as SettlementJob;
    const outcome = await reportSettlement(
      {
        harness: this.harness,
        services: this.services(),
        submissions: this.submissions,
        onSettled: this.onSettled,
        report: this.report,
      },
      operationId,
    );
    return outcome === "retry"
      ? { rescheduleAt: Date.now() + this.pollMs() }
      : undefined;
  }
}
