import type { RunId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import {
  workersAiModel,
  type GatewayFetchRoutes,
  type GatewayFetchRequest,
} from "@cubby/shared/ai/gateway-request";
import { z } from "zod";

import {
  AiBudgetExhaustedError,
  aiBudgetExemptModel,
  assertAiBudget,
} from "~/server/ai/budget";
import type { Database } from "~/server/db";
import {
  assertSelectedMailSources,
  readMailImportLineage,
  type RunExecutionIdentity,
} from "~/server/domains/run/repo/execution-lineage";

import {
  assertRunExecutable,
  pauseExecutionRun,
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

async function selectedCoordinatorExecution(
  db: Database,
  runId: RunId,
  request: GatewayFetchRequest,
): Promise<boolean> {
  const body = await request.query();
  if (
    (request.endpoint === "responses" || request.endpoint === "v1/messages") &&
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

/**
 * Run-bound paid admission: the Run must still be executable, then metered
 * calls draw from the household AI budget. A budget stop pauses the Run so
 * recovery can resume it in a later window.
 */
export function paidRunPreflight(
  db: Database,
  runId: RunId,
  feature: string,
): NonNullable<GatewayFetchRoutes["beforePaidRequest"]> {
  return async (request) => {
    // A member-requested coordinator is foreground work, not background spend.
    if (await selectedCoordinatorExecution(db, runId, request)) return;
    await assertRunExecutable(db, runId);
    // Closed-set decision models are classification: never budgeted.
    if (
      request.endpoint.startsWith("run/") &&
      aiBudgetExemptModel(workersAiModel(request.endpoint))
    )
      return;
    try {
      await assertAiBudget(db, feature);
    } catch (error) {
      if (error instanceof AiBudgetExhaustedError)
        await pauseExecutionRun(db, runId, error.message);
      throw error;
    }
    // The final admission read is the cancellation boundary.
    await assertRunExecutable(db, runId);
  };
}
