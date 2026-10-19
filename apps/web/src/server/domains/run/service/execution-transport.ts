import type { RunId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import {
  type GatewayFetchRoutes,
  type GatewayFetchRequest,
} from "@cubby/shared/ai/gateway-request";
import { z } from "zod";

import {
  AiBudgetExhaustedError,
  aiBudgetCovers,
  assertAiBudget,
} from "~/server/ai/budget";
import {
  freeBudgetRefusal,
  isBackgroundRun,
  readPaidAllowance,
} from "~/server/ai/funding";
import type { Database } from "~/server/db";
import {
  assertSelectedMailSources,
  readMailImportLineage,
  type RunExecutionIdentity,
} from "~/server/domains/run/repo/execution-lineage";

import {
  assertRunExecutable,
  pauseForFunding,
} from "../repo/execution-context";

function runningOwnerMatches(
  live: RunExecutionIdentity | undefined,
  selected: RunExecutionIdentity,
) {
  return (
    live?.status === "running" &&
    !live.retiredAt &&
    live.actorUserId === selected.actorUserId &&
    live.ledgerPartyId === selected.ledgerPartyId
  );
}

/**
 * Whether a request is a frontier chat call. Compare the path only: pi-ai's
 * Anthropic SDK posts `v1/messages?beta=true`, and an exact match on the
 * endpoint (query included) let every Claude credit call bypass the credit
 * window budget (2026-10-19: $9.98 of $5 spent with no refusal).
 */
const isChatEndpoint = (request: GatewayFetchRequest) =>
  ["responses", "v1/messages"].includes(request.endpoint.split("?")[0] ?? "");

async function selectedCoordinatorExecution(
  db: Database,
  runId: RunId,
  request: GatewayFetchRequest,
): Promise<boolean> {
  const body = await request.query();
  if (
    isChatEndpoint(request) &&
    ["gpt-6-luna", "gpt-6-sol", "claude-opus-5-5"].includes(
      z.string().parse(body.model),
    )
  ) {
    const selected = await readMailImportLineage(db, runId);
    if (!selected?.ledgerPartyId) return false;
    if (!runningOwnerMatches(selected, selected))
      throw new Error("Selected Email Run is no longer executable.");
    let current = selected;
    const visited = new Set<RunId>([runId]);
    while (true) {
      if (current.retiredAt || current.parentRunId) return false;
      const input = mailResearchRunInput.safeParse(current.input);
      if (!input.success) return false;
      if (!current.predecessorRunId) {
        if (
          current.trigger !== "foreground" ||
          current.cause !== "member_request"
        )
          return false;
        break;
      }
      if (visited.has(current.predecessorRunId)) return false;
      visited.add(current.predecessorRunId);
      const predecessor = await readMailImportLineage(
        db,
        current.predecessorRunId,
      );
      if (!predecessor) return false;
      const previousInput = mailResearchRunInput.safeParse(predecessor.input);
      // A retry inherits only its owning member's exact frozen source subset.
      if (
        predecessor.actorUserId !== selected.actorUserId ||
        predecessor.ledgerPartyId !== selected.ledgerPartyId ||
        !previousInput.success ||
        !input.data.sources.every((source) =>
          previousInput.data.sources.some(
            (previous) =>
              previous.orderMailId === source.orderMailId &&
              previous.checksum === source.checksum,
          ),
        )
      )
        return false;
      current = predecessor;
    }
    await assertSelectedMailSources(db, runId, selected.ledgerPartyId);
    const live = await readMailImportLineage(db, runId);
    if (!runningOwnerMatches(live, selected))
      throw new Error("Selected Email Run is no longer executable.");
    return true;
  }
  return false;
}

/** The frontier chat model a request names; other endpoints are never budgeted. */
async function budgetedModel(request: GatewayFetchRequest) {
  if (!isChatEndpoint(request)) return undefined;
  const model = z.object({ model: z.string() }).safeParse(await request.query())
    .data?.model;
  return model && aiBudgetCovers(model) ? model : undefined;
}

/**
 * Run-bound paid admission (ADR 0017). The Run must still be executable.
 * Every Run, background included, spends within the paid budget, or past it
 * by a "Run now, paid allowed" grant's confirmed allowance. A stop pauses the
 * Run so recovery can resume it in a later window.
 */
export function paidRunPreflight(
  db: Database,
  runId: RunId,
): NonNullable<GatewayFetchRoutes["beforePaidRequest"]> {
  return async (request) => {
    // A member-requested coordinator is foreground work, not background spend.
    if (await selectedCoordinatorExecution(db, runId, request)) return;
    await assertRunExecutable(db, runId);
    if (!(await budgetedModel(request))) return;
    try {
      await assertAiBudget(db, (await readPaidAllowance(db, runId)) ?? 0);
    } catch (error) {
      if (error instanceof AiBudgetExhaustedError)
        await pauseForFunding(db, runId, error);
      throw error;
    }
    // The final admission read is the cancellation boundary.
    await assertRunExecutable(db, runId);
  };
}

/**
 * Run-bound free-rung admission: background work stops drawing Claude credit
 * or the ChatGPT plan once that window's budget is spent. The returned
 * refusal advances the funding ladder; interactive work stays unbudgeted.
 */
export function freeRunPreflight(
  db: Database,
  runId: RunId,
): NonNullable<GatewayFetchRoutes["beforeFreeRequest"]> {
  return async (request, funding) =>
    (await budgetedModel(request)) && (await isBackgroundRun(db, runId))
      ? freeBudgetRefusal(db, funding)
      : null;
}
