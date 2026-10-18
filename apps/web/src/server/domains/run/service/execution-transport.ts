import type { RunId } from "@cubby/schemas/identifiers";
import { mailResearchRunInput } from "@cubby/schemas/run-fields";
import { CUBBY_AI_GATEWAY_ID } from "@cubby/shared/ai/gateway-metadata";
import {
  type GatewayFetchRoutes,
  type GatewayFetchRequest,
} from "@cubby/shared/ai/gateway-request";
import { z } from "zod";

import {
  AiBudgetExhaustedError,
  aiBudgetCovers,
  aiBudgetWindow,
  assertAiBudget,
} from "~/server/ai/budget";
import {
  creditBudgetRefusal,
  fundingWaitError,
  isBackgroundRun,
  type FundingStatusPorts,
} from "~/server/ai/funding";
import { getAiGatewayEgress } from "~/server/cf-env";
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
import { readPaidGrant } from "../repo/paid-grant";

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

const RESUME_MARGIN_MS = 60_000;

/**
 * A grant's confirmed spend past the paid budget lapses with the window it
 * was granted in, so one confirmation never stretches a later window.
 */
const paidAllowance = (grant: {
  createdAt: Date;
  paidOverBudgetUsd: number | null;
}) =>
  aiBudgetWindow(grant.createdAt).start.getTime() ===
  aiBudgetWindow().start.getTime()
    ? (grant.paidOverBudgetUsd ?? 0)
    : 0;

/** The frontier chat model a request names; other endpoints are never budgeted. */
async function budgetedModel(request: GatewayFetchRequest) {
  if (request.endpoint !== "responses" && request.endpoint !== "v1/messages")
    return undefined;
  const model = z.object({ model: z.string() }).safeParse(await request.query())
    .data?.model;
  return model && aiBudgetCovers(model) ? model : undefined;
}

/**
 * Run-bound paid admission (ADR 0017). The Run must still be executable.
 * Background work never pays automatically: it pauses until free capacity
 * returns, unless a member granted "Run now, paid allowed". Granted and
 * interactive work spends within the paid budget. Any stop pauses the Run so
 * recovery can resume it in a later window.
 */
export function paidRunPreflight(
  db: Database,
  runId: RunId,
  ports: FundingStatusPorts = {},
): NonNullable<GatewayFetchRoutes["beforePaidRequest"]> {
  return async (request) => {
    // A member-requested coordinator is foreground work, not background spend.
    if (await selectedCoordinatorExecution(db, runId, request)) return;
    await assertRunExecutable(db, runId);
    if (!(await budgetedModel(request))) return;
    try {
      const grant = await readPaidGrant(db, runId);
      if (!grant && (await isBackgroundRun(db, runId)))
        throw await fundingWaitError(db, ports);
      await assertAiBudget(db, grant ? paidAllowance(grant) : 0);
    } catch (error) {
      if (error instanceof AiBudgetExhaustedError) {
        await pauseExecutionRun(db, runId, error.message);
        await getAiGatewayEgress(CUBBY_AI_GATEWAY_ID)?.scheduleFundingResume(
          // Just past the boundary, so the resume reads the new window.
          Date.parse(error.status.windowEnd) + RESUME_MARGIN_MS,
        );
      }
      throw error;
    }
    // The final admission read is the cancellation boundary.
    await assertRunExecutable(db, runId);
  };
}

/**
 * Run-bound credit-rung admission: background work stops drawing Claude
 * credit once the window's credit budget is spent. The returned refusal
 * advances the funding ladder to the ChatGPT plan; interactive work keeps
 * today's unbudgeted credit.
 */
export function creditRunPreflight(
  db: Database,
  runId: RunId,
): NonNullable<GatewayFetchRoutes["beforeCreditRequest"]> {
  return async (request) =>
    (await budgetedModel(request)) && (await isBackgroundRun(db, runId))
      ? creditBudgetRefusal(db)
      : null;
}
