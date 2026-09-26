import type {
  LedgerPartyId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import {
  importRunShortcode,
  vendorAccountId,
} from "@cubby/schemas/identifiers";
import { flueImportRunPurpose } from "@cubby/schemas/import-run-agent";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  type TargetedImportLaunch,
  targetedImportPurpose,
  type TargetedImportPurpose,
  type TargetedImportStartInput,
  type TargetedImportStartOutput,
} from "~/contracts/run.contract";
import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  expense,
  importSourceClaim,
  product,
  purchase,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  dispatchImportRunEvent,
  recordImportRunDispatchAttempt,
} from "~/server/purchase-import/dispatch";
import { productEnrichmentTarget } from "~/server/purchase-import/product-enrichment-target";
import { startTargetedImportRun } from "~/server/purchase-import/run-service";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

type SourceClaim = {
  id: string;
  kind: string;
  externalKey: string;
  checksum: string;
  outputFingerprint: string;
  vendorAccountId: string | null;
  vendorAccountLabel: string | null;
  vendorId: VendorId;
  vendorShortcode: string;
};

type TargetFingerprintInput =
  | {
      purchaseId: string;
      updatedAt: Date;
      source: string | null;
    }
  /** A Product that was not found; a live one uses `productEnrichmentTarget`. */
  | { product: undefined };

const fingerprint = async (value: TargetFingerprintInput) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/**
 * Hand a committed run to the coordinator queue. A missing queue or a failed
 * send is recorded on the run as `dispatch_failed`, never thrown, so the
 * browser can offer the dispatch recovery controls.
 */
export async function dispatchStartedRun(
  db: Database,
  run: {
    id: string;
    eventId: string;
    purpose: string;
    coordinatorModel?: "gpt-6-sol";
  },
): Promise<"running" | "dispatch_failed"> {
  const queue = getPurchaseAgentQueue();
  if (!queue) {
    await recordImportRunDispatchAttempt(db, {
      runId: run.id,
      eventId: run.eventId,
      error: "Purchase import agent queue is unavailable",
    });
    return "dispatch_failed";
  }
  try {
    const event: Extract<PurchaseAgentEvent, { type: "start_or_resume" }> = {
      version: 1,
      runId: run.id,
      purpose: flueImportRunPurpose.parse(run.purpose),
      eventId: run.eventId,
      type: "start_or_resume",
    };
    if (run.coordinatorModel) event.coordinatorModel = run.coordinatorModel;
    await dispatchImportRunEvent(db, queue, event);
    return "running";
  } catch {
    return "dispatch_failed";
  }
}

async function queueStartedRun(
  db: Database,
  run: {
    id: string;
    publicId: string;
    status: string;
    purpose: string;
    dispatchEventId: string | null;
  },
) {
  if (!run.dispatchEventId)
    throw new Error("Targeted import run has no dispatch event");
  const status = await dispatchStartedRun(db, {
    id: run.id,
    eventId: run.dispatchEventId,
    purpose: run.purpose,
  });
  return {
    id: importRunShortcode.parse(run.publicId),
    status,
    purpose: targetedImportPurpose.parse(run.purpose),
    dispatchEventId: run.dispatchEventId,
  };
}

async function startedOutcome(
  db: Database,
  started: Awaited<ReturnType<typeof startTargetedImportRun>>,
): Promise<TargetedImportStartOutput["runs"][number]> {
  if (!started.created)
    return {
      created: false,
      run: null,
      blockingRun: {
        id: importRunShortcode.parse(started.blockingRun.publicId),
        status: started.blockingRun.status,
      },
    };
  return {
    created: true,
    run: await queueStartedRun(db, started.run),
    blockingRun: null,
  };
}

async function claimsForPurchase(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  purchaseId: PurchaseId,
): Promise<SourceClaim[]> {
  return await getDb(db)
    .select({
      id: importSourceClaim.id,
      kind: importSourceClaim.kind,
      externalKey: importSourceClaim.externalKey,
      checksum: importSourceClaim.checksum,
      outputFingerprint: importSourceClaim.outputFingerprint,
      vendorAccountId: importSourceClaim.vendorAccountId,
      vendorAccountLabel: vendorAccount.label,
      vendorId: vendor.id,
      vendorShortcode: vendor.shortcode,
    })
    .from(importSourceClaim)
    .innerJoin(purchase, eq(purchase.id, importSourceClaim.purchaseId))
    .innerJoin(
      vendor,
      and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
    )
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, importSourceClaim.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .where(
      and(
        eq(importSourceClaim.ledgerPartyId, ledgerPartyId),
        eq(importSourceClaim.purchaseId, purchaseId),
      ),
    )
    .orderBy(desc(importSourceClaim.updatedAt));
}

async function claimForActor(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  claimId: string,
) {
  const parsedClaimId = z.uuid().safeParse(claimId);
  if (!parsedClaimId.success) return null;
  const [claim] = await getDb(db)
    .select({
      id: importSourceClaim.id,
      kind: importSourceClaim.kind,
      externalKey: importSourceClaim.externalKey,
      checksum: importSourceClaim.checksum,
      outputFingerprint: importSourceClaim.outputFingerprint,
      purchaseId: importSourceClaim.purchaseId,
      vendorAccountId: importSourceClaim.vendorAccountId,
      vendorId: vendor.id,
      vendorShortcode: vendor.shortcode,
    })
    .from(importSourceClaim)
    .innerJoin(purchase, eq(purchase.id, importSourceClaim.purchaseId))
    .innerJoin(
      vendor,
      and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
    )
    .where(
      and(
        eq(importSourceClaim.id, parsedClaimId.data),
        eq(importSourceClaim.ledgerPartyId, ledgerPartyId),
      ),
    )
    .limit(1);
  return claim ?? null;
}

const claimLabel = (claim: { kind: string; externalKey: string }) =>
  `${claim.kind.replaceAll("_", " ")} · ${claim.externalKey}`;

/** The sources a targeted run could replay for one Purchase or Product. */
export async function loadTargetedImportLaunch(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  purpose: TargetedImportPurpose,
  targetId: string,
): Promise<TargetedImportLaunch> {
  if (purpose === "purchase_validation") {
    const purchaseId = await resolveOrThrow(db, "purchase", targetId);
    const [target] = await getDb(db)
      .select({
        shortcode: purchase.shortcode,
        displayLabel: purchase.displayLabel,
        orderId: purchase.orderId,
        vendorName: vendor.name,
      })
      .from(purchase)
      .innerJoin(
        vendor,
        and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
      )
      .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
      .limit(1);
    if (!target) throw new Error("Target was not found");
    const claims = await claimsForPurchase(db, ledgerPartyId, purchaseId);
    return {
      purpose,
      purchase: {
        id: target.shortcode,
        label: target.displayLabel ?? target.orderId ?? target.vendorName,
        canValidate: true,
        reason:
          claims.length > 0
            ? null
            : "No replayable claim exists; the run will search Gmail, then use an owned browser account when available.",
        sources: claims.map((claim, index) => ({
          id: claim.id,
          label: claimLabel(claim),
          kind: claim.kind,
          fingerprint: claim.checksum,
          vendorAccountId: claim.vendorAccountId,
          vendorAccountLabel: claim.vendorAccountLabel,
          usable: true,
          reason: null,
          default: index === 0 && claim.kind === "browser_order",
        })),
        products: [],
      },
      products: [],
    };
  }

  const productId = await resolveOrThrow(db, "product", targetId);
  const [target] = await getDb(db)
    .select({ name: product.name })
    .from(product)
    .where(and(eq(product.id, productId), notDeleted(product)))
    .limit(1);
  if (!target) throw new Error("Target was not found");
  const [claim] = await getDb(db)
    .select({
      id: importSourceClaim.id,
      kind: importSourceClaim.kind,
      externalKey: importSourceClaim.externalKey,
      vendorAccountId: importSourceClaim.vendorAccountId,
      vendorAccountLabel: vendorAccount.label,
    })
    .from(expense)
    .innerJoin(
      purchase,
      and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
    )
    .innerJoin(
      importSourceClaim,
      and(
        eq(importSourceClaim.purchaseId, purchase.id),
        eq(importSourceClaim.ledgerPartyId, ledgerPartyId),
      ),
    )
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, importSourceClaim.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .where(and(eq(expense.productId, productId), notDeleted(expense)))
    .orderBy(desc(importSourceClaim.updatedAt))
    .limit(1);
  return {
    purpose,
    purchase: null,
    products: [
      {
        productId: targetId,
        productName: target.name,
        selected: Boolean(claim),
        sourceId: claim?.id ?? null,
        sourceLabel: claim ? claimLabel(claim) : null,
        vendorAccountId: claim?.vendorAccountId ?? null,
        vendorAccountLabel: claim?.vendorAccountLabel ?? null,
        needsAccountChoice: false,
        accountChoices: [],
        reason: claim ? null : "No verified purchase source is available.",
      },
    ],
  };
}

async function startPurchaseValidation(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  input: Extract<TargetedImportStartInput, { purpose: "purchase_validation" }>,
): Promise<TargetedImportStartOutput> {
  const purchaseId = await resolveOrThrow(db, "purchase", input.purchaseId);
  const claim = input.sourceId
    ? await claimForActor(db, ledgerPartyId, input.sourceId)
    : null;
  if (claim && claim.purchaseId !== purchaseId)
    throw new Error("Choose a current replayable source");
  const [purchaseScope] = await getDb(db)
    .select({
      vendorId: purchase.vendorId,
      vendorAccountId: purchase.vendorAccountId,
      orderId: purchase.orderId,
      updatedAt: purchase.updatedAt,
    })
    .from(purchase)
    .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
    .limit(1);
  if (!purchaseScope?.vendorId || !purchaseScope.orderId)
    throw new Error("Purchase needs a Vendor and order ID");
  const accountId = claim?.vendorAccountId
    ? vendorAccountId.parse(claim.vendorAccountId)
    : purchaseScope.vendorAccountId
      ? vendorAccountId.parse(purchaseScope.vendorAccountId)
      : null;
  const started = await startTargetedImportRun(db, {
    ledgerPartyId,
    purpose: "purchase_validation",
    vendorId: claim?.vendorId ?? purchaseScope.vendorId,
    vendorAccountId: accountId,
    trigger: "manual",
    targets: [
      {
        kind: "purchase",
        purchaseId,
        vendorAccountId: accountId,
        sourceKind: claim?.kind ?? null,
        sourceExternalKey: claim?.externalKey ?? purchaseScope.orderId,
        targetFingerprint: await fingerprint({
          purchaseId,
          updatedAt: purchaseScope.updatedAt,
          source: claim?.outputFingerprint ?? null,
        }),
        evidenceFingerprint: claim?.checksum ?? null,
      },
    ],
  });
  return { runs: [await startedOutcome(db, started)] };
}

async function startProductEnrichment(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  input: Extract<TargetedImportStartInput, { purpose: "product_enrichment" }>,
): Promise<TargetedImportStartOutput> {
  const resolved = await Promise.all(
    input.targets.map(async (target) => {
      const productId = await resolveOrThrow(db, "product", target.productId);
      const claim = target.sourceId
        ? await claimForActor(db, ledgerPartyId, target.sourceId)
        : null;
      const productState = await productEnrichmentTarget(getDb(db), productId);
      const [sourceLine] = claim?.purchaseId
        ? await getDb(db)
            .select({ id: expense.id })
            .from(expense)
            .where(
              and(
                eq(expense.purchaseId, claim.purchaseId),
                eq(expense.productId, productId),
                notDeleted(expense),
              ),
            )
            .limit(1)
        : [];
      if (!claim || !sourceLine)
        throw new Error(
          "Every product needs a verified source that contains it",
        );
      return {
        productId,
        claim,
        targetFingerprint:
          productState?.fingerprint ??
          (await fingerprint({ product: undefined })),
      };
    }),
  );
  const groups = new Map<string, typeof resolved>();
  for (const row of resolved) {
    const key = `${row.claim.vendorId}:${row.claim.vendorAccountId ?? "none"}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const runs = await Promise.all(
    [...groups.values()].map(async (group) => {
      const { claim } = group[0]!;
      const started = await startTargetedImportRun(db, {
        ledgerPartyId,
        purpose: "product_enrichment",
        vendorId: claim.vendorId,
        vendorAccountId: claim.vendorAccountId
          ? vendorAccountId.parse(claim.vendorAccountId)
          : null,
        trigger: "manual",
        targets: group.map((row) => ({
          kind: "product" as const,
          productId: row.productId,
          vendorAccountId: row.claim.vendorAccountId
            ? vendorAccountId.parse(row.claim.vendorAccountId)
            : null,
          sourceKind: row.claim.kind,
          sourceExternalKey: row.claim.externalKey,
          targetFingerprint: row.targetFingerprint,
          evidenceFingerprint: row.claim.checksum,
        })),
      });
      return startedOutcome(db, started);
    }),
  );
  return { runs };
}

/** Admit and dispatch targeted validation or enrichment runs. */
export function startTargetedImport(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  input: TargetedImportStartInput,
): Promise<TargetedImportStartOutput> {
  return input.purpose === "purchase_validation"
    ? startPurchaseValidation(db, ledgerPartyId, input)
    : startProductEnrichment(db, ledgerPartyId, input);
}
