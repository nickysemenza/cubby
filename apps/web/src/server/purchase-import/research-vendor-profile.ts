import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ProposedImportFix } from "@cubby/schemas/purchase-import";
import { retainedResearchObservation } from "@cubby/schemas/research";
import {
  vendorAgentHints,
  type vendorCaptureProfile,
} from "@cubby/schemas/vendor-import-fields";
import { validateExternalHttpUrl } from "@cubby/shared/external-fetch";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type { DrizzleTransaction } from "~/server/db";
import {
  ledgerParty,
  run,
  runEvidence,
  runFinding,
  runTarget,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  databaseForTransaction,
  notDeleted,
} from "~/server/repo/database-helpers";
import { updateVendor } from "~/server/repo/vendor";

import {
  readVerifiedResearchEvidence,
  type ResearchEvidenceReader,
} from "./research-evidence";
import { researchObjectiveFor } from "./research-objective-context";

type Profile = z.infer<typeof vendorCaptureProfile>;
type Fix = Extract<ProposedImportFix, { kind: "vendor_capture_profile" }>;

const navigationURL = (raw: string) => {
  const url = validateExternalHttpUrl(raw);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error(
      "Capture profile navigation requires credential-free HTTPS URLs.",
    );
  return url;
};

function observedNavigationURLs(
  observation: z.infer<typeof retainedResearchObservation>["observation"],
) {
  return [
    observation.sourceURL,
    observation.servedURL,
    ...observation.links.map((link) => link.url),
  ].flatMap((raw) => {
    if (!raw) return [];
    try {
      return [navigationURL(raw).href];
    } catch {
      // SILENT: unrelated unsafe links confer no navigation or browser-host authority.
      return [];
    }
  });
}

function assertFrozenAccount(
  scope: typeof run.$inferSelect,
  target: typeof runTarget.$inferSelect,
) {
  const objective = researchObjectiveFor(scope, target);
  if (
    objective?.kind !== "account_history" ||
    objective.vendorAccountId !== scope.vendorAccountId
  )
    throw new Error(
      "Capture profile must remain bound to its frozen account-history objective.",
    );
}

async function profileState(
  tx: DrizzleTransaction,
  runId: string,
  targetId: string,
  profile: Profile,
  readEvidence?: ResearchEvidenceReader,
) {
  const scope = await tx.query.run.findFirst({
    where: and(eq(run.id, parseEntityId("run", runId)), notDeleted(run)),
  });
  const target = await tx.query.runTarget.findFirst({
    where: and(
      eq(runTarget.id, targetId),
      eq(runTarget.runId, parseEntityId("run", runId)),
    ),
  });
  if (
    !scope ||
    scope.retiredAt ||
    !target ||
    !scope.vendorAccountId ||
    !scope.ledgerPartyId ||
    !scope.actorUserId
  )
    throw new Error(
      "Capture profile requires a retained owned account-history objective.",
    );
  assertFrozenAccount(scope, target);
  const [binding] = await tx
    .select({ account: vendorAccount, vendor })
    .from(vendorAccount)
    .innerJoin(
      vendor,
      and(eq(vendor.id, vendorAccount.vendorId), notDeleted(vendor)),
    )
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, vendorAccount.ledgerPartyId),
        eq(ledgerParty.userId, scope.actorUserId),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        eq(vendorAccount.id, scope.vendorAccountId),
        eq(vendorAccount.ledgerPartyId, scope.ledgerPartyId),
        notDeleted(vendorAccount),
      ),
    )
    .for("update", { of: vendor });
  if (!binding || binding.vendor.id !== scope.vendorId)
    throw new Error(
      "Capture profile retained Vendor or account ownership changed.",
    );
  const ids = [...new Set(profile.evidenceIds)].sort();
  const evidence = await tx
    .select()
    .from(runEvidence)
    .where(
      and(
        eq(runEvidence.runId, scope.id),
        eq(runEvidence.targetId, target.id),
        inArray(runEvidence.id, ids),
      ),
    )
    .orderBy(runEvidence.id);
  if (evidence.length !== ids.length)
    throw new Error(
      "Capture profile evidence does not belong to this objective.",
    );
  const urls = new Set<string>();
  for (const source of evidence) {
    if (!["web_page", "browser_capture"].includes(source.kind))
      throw new Error("Capture profile requires retained page evidence.");
    await readVerifiedResearchEvidence(source, readEvidence);
    const metadata = z
      .object({
        brokerAccountId: z.uuid().optional(),
        research: retainedResearchObservation,
      })
      .parse(source.sourceMetadata);
    if (
      metadata.brokerAccountId &&
      metadata.brokerAccountId !== binding.account.id
    )
      throw new Error(
        "Capture profile browser source belongs to another account.",
      );
    for (const url of observedNavigationURLs(metadata.research.observation))
      urls.add(url);
  }
  if (
    profile.hints.ordersListUrl &&
    !urls.has(navigationURL(profile.hints.ordersListUrl).href)
  )
    throw new Error(
      "Capture profile order-history URL was not observed in its retained sources.",
    );
  const supportedHosts = new Set([
    ...binding.vendor.browserDomains,
    ...[...urls].map((raw) => new URL(raw).hostname),
  ]);
  if (profile.browserDomains.some((host) => !supportedHosts.has(host)))
    throw new Error(
      "Capture profile host was not observed or previously authorized.",
    );
  const current = {
    hints: vendorAgentHints.parse(binding.vendor.agentHints),
    browserDomains: binding.vendor.browserDomains,
  };
  const fingerprint = await sha256Hex(
    JSON.stringify({
      runId: scope.id,
      targetId: target.id,
      accountId: binding.account.id,
      vendorId: binding.vendor.id,
      current,
      profile,
      evidence: evidence.map((row) => ({
        id: row.id,
        checksum: row.checksum,
        metadata: row.sourceMetadata,
      })),
    }),
  );
  return { scope, target, binding, current, fingerprint };
}

export async function proposeVendorCaptureProfile(
  tx: DrizzleTransaction,
  runId: string,
  targetId: string,
  profile: Profile,
  readEvidence?: ResearchEvidenceReader,
) {
  const state = await profileState(tx, runId, targetId, profile, readEvidence);
  const existing = await tx.query.runFinding.findFirst({
    where: and(
      eq(runFinding.runId, state.scope.id),
      eq(runFinding.evidenceFingerprint, state.fingerprint),
    ),
  });
  if (existing) return existing.id;
  const fix: Fix = {
    kind: "vendor_capture_profile",
    runId: state.scope.id,
    vendorId: state.binding.vendor.id,
    vendorAccountId: state.binding.account.id,
    targetId,
    profile,
    current: state.current,
    reviewSnapshot: { fingerprint: state.fingerprint },
  };
  const [finding] = await tx
    .insert(runFinding)
    .values({
      runId: state.scope.id,
      ledgerPartyId: state.scope.ledgerPartyId!,
      entityKind: "run",
      entityId: state.scope.id,
      kind: "other",
      summary: "Review learned account navigation and browser hosts.",
      proposedFix: fix,
      evidenceFingerprint: state.fingerprint,
    })
    .returning({ id: runFinding.id });
  if (!finding) throw new Error("Capture profile review was not retained.");
  return finding.id;
}

export async function applyVendorCaptureProfile(
  tx: DrizzleTransaction,
  actor: ActorContext,
  finding: Pick<
    typeof runFinding.$inferSelect,
    "runId" | "ledgerPartyId" | "entityId"
  >,
  fix: Fix,
  reviewedFingerprint?: string | null,
  readEvidence?: ResearchEvidenceReader,
) {
  if (!finding.runId || reviewedFingerprint !== fix.reviewSnapshot.fingerprint)
    throw new Error("Review the current capture profile before applying it.");
  const state = await profileState(
    tx,
    finding.runId,
    fix.targetId,
    fix.profile,
    readEvidence,
  );
  if (
    state.scope.actorUserId !== actor.userId ||
    state.scope.ledgerPartyId !== finding.ledgerPartyId ||
    state.binding.vendor.id !== fix.vendorId ||
    state.binding.account.id !== fix.vendorAccountId ||
    finding.entityId !== fix.runId ||
    finding.runId !== fix.runId ||
    state.fingerprint !== reviewedFingerprint
  )
    throw new Error(
      "Capture profile account, Vendor or evidence changed; review a fresh proposal.",
    );
  await updateVendor(
    databaseForTransaction(tx),
    parseShortcodeFor("vendor", state.binding.vendor.shortcode),
    {
      agentHints: fix.profile.hints,
      browserDomains: fix.profile.browserDomains,
    },
    actor,
  );
}
