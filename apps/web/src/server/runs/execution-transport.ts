import type { LedgerPartyId, RunId } from "@cubby/schemas/identifiers";
import {
  isMailReclassifyRun,
  isAiRefreshMailRun,
  mailResearchRunInput,
} from "@cubby/schemas/run-fields";
import {
  workersAiModel,
  type GatewayFetchRoutes,
  type GatewayFetchRequest,
} from "@cubby/shared/ai/gateway-request";
import {
  supportedDecisionModelSchema,
  providerFor,
} from "@cubby/shared/ai/models";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import {
  quoteAiDecisionRequestUsd,
  quoteAiChatRequestUsd,
} from "~/server/ai/pricing";
import type { Database } from "~/server/db";
import { ledgerParty, run } from "~/server/db/schema";
import { readMailRunSources } from "~/server/purchase-import/mail-run-membership";
import { assertMailSourceIdentityReady } from "~/server/purchase-import/mail-source-identity";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { readRetainedMail } from "~/server/repo/retained-mail";

import {
  assertExecutionAuthorization,
  reserveExecutionAuthorization,
} from "./execution-authorization";
import {
  executionAuthorizationFromInput,
  executionRequestForRun,
  pauseExecutionRun,
} from "./execution-context";

const decisionQuestions = z.object({
  questions: z.record(z.string(), z.unknown()),
});

async function assertSelectedMailSources(
  db: Database,
  runId: RunId,
  ledgerPartyId: LedgerPartyId,
): Promise<void> {
  const sources = await readMailRunSources(getDb(db), runId);
  const originals = await readRetainedMail(db, {
    ledgerPartyIds: [ledgerPartyId],
    orderMailIds: sources.map((source) => source.orderMailId),
  });
  for (const source of sources) {
    const original = originals.find((item) => item.id === source.orderMailId);
    if (
      !source.owned ||
      !source.unchanged ||
      source.email.ledgerPartyId !== ledgerPartyId ||
      source.email.deletedAt ||
      ["excluded", "deleted"].includes(source.email.status) ||
      !original ||
      original.rawChecksum !== source.checksum
    )
      throw new Error("Selected Email source evidence or ownership changed.");
    await assertMailSourceIdentityReady(getDb(db), original);
  }
}

type RunExecutionIdentity = Pick<
  typeof run.$inferSelect,
  "status" | "retiredAt" | "actorUserId" | "ledgerPartyId"
>;

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

async function selectedLunaExecution(
  db: Database,
  runId: RunId,
  request: GatewayFetchRequest,
): Promise<boolean> {
  const body = await request.query();
  if (request.endpoint === "responses" && body.model === "gpt-6-luna") {
    const readLineage = (id: RunId) =>
      getDb(db)
        .select({
          actorUserId: run.actorUserId,
          ledgerPartyId: run.ledgerPartyId,
          status: run.status,
          retiredAt: run.retiredAt,
          purpose: run.purpose,
          trigger: run.trigger,
          cause: run.cause,
          parentRunId: run.parentRunId,
          predecessorRunId: run.predecessorRunId,
          input: run.input,
        })
        .from(run)
        .innerJoin(
          ledgerParty,
          and(
            eq(ledgerParty.id, run.ledgerPartyId),
            eq(ledgerParty.userId, run.actorUserId),
            eq(ledgerParty.kind, "member"),
            notDeleted(ledgerParty),
          ),
        )
        .where(
          and(eq(run.id, id), eq(run.purpose, "mail_import"), notDeleted(run)),
        )
        .limit(1);
    const [selected] = await readLineage(runId);
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
      const [predecessor] = await readLineage(current.predecessorRunId);
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
    const [live] = await readLineage(runId);
    if (!runningOwnerMatches(live, selected))
      throw new Error("Selected Email Run is no longer executable.");
    return true;
  }
  return false;
}

/** Check live execution authority; metered models reserve their full bill. */
export function paidResearchPreflight(
  db: Database,
  runId: RunId,
): NonNullable<GatewayFetchRoutes["beforePaidRequest"]> {
  return async (request) => {
    if (await selectedLunaExecution(db, runId, request)) return;
    const authority = await executionRequestForRun(db, runId, {
      requireRunning: true,
    });
    if (!authority) {
      throw new Error(
        "Paid research requires an explicit execution authorization.",
      );
    }
    await assertExecutionAuthorization(db, authority);
    const assertCurrentRun = async () => {
      const [current] = await getDb(db)
        .select({
          status: run.status,
          purpose: run.purpose,
          retiredAt: run.retiredAt,
          input: run.input,
          actorUserId: run.actorUserId,
          ledgerPartyId: run.ledgerPartyId,
        })
        .from(run)
        .where(and(eq(run.id, runId), notDeleted(run)))
        .limit(1);
      if (!current || current.retiredAt || current.status !== "running")
        throw new Error("Execution authorization Run is no longer executable.");
      const ref = executionAuthorizationFromInput(current.input);
      if (
        ref?.runId !== authority.ref.runId ||
        ref.approvalFingerprint !== authority.ref.approvalFingerprint ||
        current.actorUserId !== authority.owner.userId ||
        current.ledgerPartyId !== authority.owner.ledgerPartyId
      )
        throw new Error("Execution authorization Run binding changed.");
      return current;
    };
    const body = await request.query();
    const quote =
      request.endpoint === "responses"
        ? await quoteAiChatRequestUsd({
            provider: "openai",
            model: z.string().parse(body.model),
          })
        : await quoteAiDecisionRequestUsd({
            provider: providerFor(
              supportedDecisionModelSchema.parse(
                workersAiModel(request.endpoint),
              ),
            ),
            model: supportedDecisionModelSchema.parse(
              workersAiModel(request.endpoint),
            ),
            questionCount: Object.keys(decisionQuestions.parse(body).questions)
              .length,
          });
    if (!quote)
      throw new Error(
        "Paid research allowance cannot price this model call's full billing bounds.",
      );
    const reservationMicroUSD = Math.ceil(quote.maxCostUsd * 1_000_000);
    if (!Number.isSafeInteger(reservationMicroUSD))
      throw new Error(
        "Paid research allowance exceeds safe integer accounting.",
      );
    const current = await assertCurrentRun();
    // The household authorizes unlimited classification-tier dollars. A
    // classification Run still needs live ownership, authorization and bounds;
    // responses and other models retain their original monetary allowance.
    if (
      (current.purpose === "mail_discovery" ||
        current.purpose === "mail_import" ||
        isMailReclassifyRun(current) ||
        isAiRefreshMailRun(current)) &&
      request.endpoint !== "responses" &&
      ["typesafe/jev", "@cf/cloudflare/clef"].includes(
        workersAiModel(request.endpoint),
      )
    )
      return;
    if (reservationMicroUSD === 0) return;
    const decision = await reserveExecutionAuthorization(db, {
      ...authority,
      physicalAttemptId: crypto.randomUUID(),
      reservationMicroUSD,
    });
    if (decision.status === "refused") {
      const message = `Paid research allowance refused: ${decision.reason}.`;
      if (decision.reason === "budget_exhausted")
        await pauseExecutionRun(db, runId, message);
      throw new Error(message);
    }
    // The final admission read is the cancellation boundary. Keep a committed
    // reservation when cancellation wins here; it must never grant a retry.
    await assertCurrentRun();
  };
}
