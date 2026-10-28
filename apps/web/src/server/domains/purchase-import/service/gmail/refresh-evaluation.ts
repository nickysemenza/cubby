import { userId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import type { ClaimedAiEvaluation } from "~/server/ai/evaluation/repo/ai-evaluation";
import { dependenciesCurrent } from "~/server/ai/policy/refresh-manifest";
import { readAiRefreshActivation } from "~/server/ai/repo/ai-refresh";
import type { Database } from "~/server/db";
import {
  blockUnpublishedEmailRefresh,
  latestClassificationObservation,
  loadEmailRefreshTarget,
} from "~/server/domains/purchase-import/repo/gmail/refresh-evaluation-state";

import { gmailProviderForUser } from "../../repo/gmail/provider";
import { ingestGmailMessages } from "./ingest";

export async function refreshEmailEvaluation(
  db: Database,
  evaluation: ClaimedAiEvaluation,
  ports: Pick<
    Parameters<typeof ingestGmailMessages>[2],
    "triage" | "relevance" | "storage"
  > = {},
) {
  const [{ current, owner }, activation] = await Promise.all([
    loadEmailRefreshTarget(db, evaluation),
    readAiRefreshActivation(db),
  ]);
  if (
    !current ||
    !owner ||
    !owner.actorUserId ||
    current.member ||
    current.item.classification !== "uncertain"
  )
    throw new Error("AI evaluation member decision is obsolete");
  const snapshot = z
    .object({ checksum: z.string().nullable() })
    .parse(evaluation.snapshot);
  if (snapshot.checksum !== current.item.checksum)
    throw new Error("AI evaluation target changed during inference");
  const observation = await latestClassificationObservation(
    db,
    current.item.id,
  );
  const reusable = (feature: string) => {
    const stamp = observation?.provenance?.dependencies.find(
      (entry) => entry.feature === feature,
    );
    return Boolean(
      stamp &&
      activation &&
      observation?.checksum === current.item.checksum &&
      dependenciesCurrent(
        { ...evaluation.provenance, dependencies: [stamp] },
        activation.manifest,
      ),
    );
  };
  const provider = await gmailProviderForUser(
    db,
    userId.parse(owner.actorUserId),
  );
  const outcome = await ingestGmailMessages(db, provider, {
    ...ports,
    ledgerPartyId: current.item.ledgerPartyId,
    mailboxId: current.item.mailboxId,
    messageIds: [current.item.messageId],
    runId: owner.id,
    reclassify: true,
    refreshStage: reusable("mailbox-triage")
      ? "mailbox-relevance"
      : "mailbox-triage",
    refreshDependencies: observation?.provenance?.dependencies,
    evaluation: { id: evaluation.id, token: evaluation.attemptToken },
  });
  // The acquisition fence can decline before publication (missing/historical source).
  await blockUnpublishedEmailRefresh(
    db,
    evaluation.id,
    evaluation.attemptToken,
    JSON.parse(
      JSON.stringify({
        reason: "source_unavailable_or_protected",
        outcome,
      }),
    ),
  );
}
