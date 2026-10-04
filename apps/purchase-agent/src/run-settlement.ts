import type { PiHarness } from "agents/harness/pi";
import {
  LifecycleCapability,
  type LifecycleJobContext,
  type LifecycleJobOutcome,
} from "agents/lifecycle";

import type { AgentConversationSettlement } from "@cubby/schemas/agent-conversation";

import type { PurchaseImportService } from "./service";
import { settlementReport } from "./settlement";

const POLL_MS = 10_000;

type SettlementJob = { operationId: string; runId: string };

/**
 * One durable job per submitted operation reports its settlement to the web
 * Worker. pi settles operations in memory, and this object may be evicted
 * while a run is in flight, so the report rides a Lifecycle job: its alarm
 * survives eviction, and each dispatch is bounded (check, report or
 * reschedule). Reports are idempotent by `submission-settled:<operationId>`.
 */
export class RunSettlement extends LifecycleCapability {
  constructor(
    private readonly harness: PiHarness,
    private readonly service: () => PurchaseImportService,
    private readonly report: <TError>(error: TError) => void,
    private readonly onSettled: (settled: AgentConversationSettlement) => void,
  ) {
    super("cubby-run-settlement");
  }

  async watch(job: SettlementJob): Promise<void> {
    await this.lifecycle.jobs.push({
      id: `settle:${job.operationId}`,
      fn: "settle",
      time: Date.now() + POLL_MS,
      payload: job,
      singleflight: true,
    });
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    // SAFETY: only `watch` pushes jobs for this capability, with this payload.
    const { operationId, runId } = job.payload as SettlementJob;
    const pending = await this.harness.pending();
    if (pending.some((operation) => operation.operationId === operationId))
      return { rescheduleAt: Date.now() + POLL_MS };
    const result = await this.harness.wait(operationId);
    const settled: AgentConversationSettlement = {
      operationId,
      outcome: result.status,
    };
    if (result.reason) settled.reason = result.reason;
    this.onSettled(settled);
    const report = settlementReport(result);
    const service = this.service();
    const settledId = `submission-settled:${operationId}`;
    try {
      if (report.kind === "reconcile") {
        await service.reconcileSettledRun({ runId, operationId: settledId });
        return undefined;
      }
      await Promise.all([
        service.markRunFailed({
          runId,
          operationId: settledId,
          failureCode: report.failureCode,
          detail: report.detail,
        }),
        service.updateAgentProgress({
          runId,
          eventId: settledId,
          phase: "review",
          detail: report.detail,
        }),
      ]);
    } catch (error) {
      // The web Worker was unreachable; keep the job and try again.
      this.report(error);
      return { rescheduleAt: Date.now() + POLL_MS };
    }
    return undefined;
  }
}
