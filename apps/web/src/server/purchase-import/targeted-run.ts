import type {
  LedgerPartyId,
  ProductId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import {
  vendorAccountId,
  vendorAccountShortcode,
  userId,
  runShortcode,
} from "@cubby/schemas/identifiers";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";

import {
  type TargetedImportLaunch,
  type TargetedImportPurpose,
  type TargetedImportStartInput,
  type TargetedImportStartOutput,
} from "~/contracts/run.contract";
import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  importSourceClaim,
  importSourceOrder,
  ledgerParty,
  run,
  product,
  purchase,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import { browsingAccountFor } from "~/server/purchase-import/browsing-account";
import {
  dispatchRunEvent,
  recordRunDispatchAttempt,
} from "~/server/purchase-import/dispatch";
import {
  purchasedResearchProducts,
  startProductResearch,
} from "~/server/purchase-import/product-research-run";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  previewPurchaseValidationSource,
  startPurchaseValidationResearch,
} from "./purchase-validation-research";
import { admitVendorResearch } from "./vendor-research-run";

type SourceClaim = {
  id: string;
  kind: string;
  externalKey: string;
  checksum: string;
  outputFingerprint: string;
  vendorAccountShortcode: string | null;
  vendorAccountLabel: string | null;
  vendorId: VendorId;
  vendorShortcode: string;
};

const accountShortcode = vendorAccountShortcode.nullable();

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
  },
): Promise<"running" | "dispatch_failed"> {
  const queue = getPurchaseAgentQueue();
  if (!queue) {
    await recordRunDispatchAttempt(db, {
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
      purpose: agentImportRunPurpose.parse(run.purpose),
      eventId: run.eventId,
      type: "start_or_resume",
    };
    await dispatchRunEvent(db, queue, event);
    return "running";
  } catch {
    return "dispatch_failed";
  }
}

async function claimsForPurchase(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  purchaseId: PurchaseId,
): Promise<SourceClaim[]> {
  return await getDb(db)
    .select({
      id: importSourceOrder.id,
      kind: importSourceClaim.kind,
      externalKey: importSourceClaim.externalKey,
      checksum: importSourceOrder.checksum,
      outputFingerprint: importSourceOrder.outputFingerprint,
      vendorAccountShortcode: vendorAccount.shortcode,
      vendorAccountLabel: vendorAccount.label,
      vendorId: vendor.id,
      vendorShortcode: vendor.shortcode,
    })
    .from(importSourceOrder)
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .innerJoin(
      purchase,
      and(eq(purchase.id, importSourceOrder.purchaseId), notDeleted(purchase)),
    )
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
        eq(importSourceOrder.purchaseId, purchaseId),
      ),
    )
    .orderBy(desc(importSourceOrder.updatedAt));
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
    const sources = await Promise.all(
      claims.map(async (claim) => {
        const preview = await previewPurchaseValidationSource(
          db,
          ledgerPartyId,
          purchaseId,
          claim.id,
        );
        return {
          id: claim.id,
          label: claimLabel(claim),
          kind: claim.kind,
          fingerprint: claim.checksum,
          vendorAccountId: accountShortcode.parse(
            preview.account?.shortcode ?? null,
          ),
          vendorAccountLabel: preview.account?.label ?? null,
          usable: preview.usable,
          reason: preview.reason,
          default: false,
        };
      }),
    );
    const preferred = sources.find(
      (source) => source.usable && source.kind === "browser_order",
    );
    if (preferred) preferred.default = true;
    return {
      purpose,
      purchase: {
        id: target.shortcode,
        label: target.displayLabel ?? target.orderId ?? target.vendorName,
        canValidate: true,
        reason:
          claims.length > 0
            ? null
            : "Research the recorded Purchase using owned mail, public sources, or an uploaded original. Browser access is optional.",
        sources,
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
  const claims = await productResearchSources(db, ledgerPartyId, [productId]);
  const claim = claims[0];
  const [accountId] = await enrichmentAccountIds(
    db,
    ledgerPartyId,
    claim ? [claim] : [],
  );
  const [account] = accountId
    ? await getDb(db)
        .select({
          shortcode: vendorAccount.shortcode,
          label: vendorAccount.label,
        })
        .from(vendorAccount)
        .where(
          and(
            eq(vendorAccount.id, vendorAccountId.parse(accountId)),
            notDeleted(vendorAccount),
          ),
        )
        .limit(1)
    : [];
  return {
    purpose,
    purchase: null,
    products: [
      {
        productId: targetId,
        productName: target.name,
        selected: true,
        sourceId: claim?.id ?? null,
        sourceLabel: claim ? claimLabel(claim) : null,
        vendorAccountId: accountShortcode.parse(account?.shortcode ?? null),
        vendorAccountLabel: account?.label ?? null,
        needsAccountChoice: false,
        accountChoices: [],
        reason: claim ? null : "Research this Product using public sources.",
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
  const [owner] = await getDb(db)
    .select({ userId: ledgerParty.userId })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.id, ledgerPartyId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    );
  if (!owner?.userId) throw new Error("Validation requires the owning member.");
  const started = await startPurchaseValidationResearch(db, {
    ledgerPartyId,
    userId: userId.parse(owner.userId),
    purchaseIds: [purchaseId],
    selectedSources: input.sourceId
      ? [{ purchaseId, sourceOrderId: input.sourceId }]
      : [],
  });
  return {
    runs: [
      {
        created: started.created,
        run: started.created
          ? {
              id: runShortcode.parse(started.row.shortcode),
              status: started.row.status,
              purpose: "purchase_validation",
              dispatchEventId: started.row.dispatchEventId,
            }
          : null,
        blockingRun: started.created
          ? null
          : {
              id: runShortcode.parse(started.row.shortcode),
              status: started.row.status,
            },
      },
    ],
  };
}

async function productResearchSources(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  productIds: readonly ProductId[],
) {
  const contexts = await purchasedResearchProducts(getDb(db), { productIds });
  return contexts
    .flatMap((row) =>
      "sourceOrderId" in row &&
      row.ledgerPartyId === ledgerPartyId &&
      row.checksum === row.orderChecksum
        ? [
            {
              id: row.sourceOrderId,
              productId: row.productId,
              kind: row.sourceKind,
              externalKey: row.sourceKey,
              vendorId: row.vendorId,
              vendorAccountId: row.vendorAccountId,
            },
          ]
        : [],
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Optional owned Chrome transport; ambiguity leaves research cloud-capable. */
async function enrichmentAccountIds(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  claims: readonly {
    vendorId: VendorId | null;
    vendorAccountId: string | null;
  }[],
) {
  const vendorIds = claims.flatMap((claim) =>
    claim.vendorId ? [claim.vendorId] : [],
  );
  const accounts = vendorIds.length
    ? await getDb(db)
        .select()
        .from(vendorAccount)
        .where(
          and(
            inArray(vendorAccount.vendorId, vendorIds),
            eq(vendorAccount.ledgerPartyId, ledgerPartyId),
            eq(vendorAccount.browser, "chrome"),
            eq(vendorAccount.browserSyncEnabled, true),
            ne(vendorAccount.status, "disabled"),
            notDeleted(vendorAccount),
          ),
        )
        .orderBy(asc(vendorAccount.id))
    : [];
  return claims.map((claim) =>
    claim.vendorId
      ? (browsingAccountFor(accounts, { ...claim, vendorId: claim.vendorId })
          ?.id ?? null)
      : null,
  );
}

async function startProductEnrichment(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  input: Extract<TargetedImportStartInput, { purpose: "product_enrichment" }>,
): Promise<TargetedImportStartOutput> {
  const [member] = await getDb(db)
    .select({ userId: ledgerParty.userId })
    .from(ledgerParty)
    .where(
      and(
        eq(ledgerParty.id, ledgerPartyId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .limit(1);
  if (!member?.userId)
    throw new Error("Product research member ownership is unavailable.");
  const targets = await Promise.all(
    input.targets.map(async (target) => ({
      productId: await resolveOrThrow(db, "product", target.productId),
      sourceOrderId:
        target.sourceId === null ? null : z.uuid().parse(target.sourceId),
    })),
  );
  const sources = await productResearchSources(
    db,
    ledgerPartyId,
    targets.map((target) => target.productId),
  );
  const preferences = await enrichmentAccountIds(
    db,
    ledgerPartyId,
    targets.flatMap((target) => {
      const source = sources.find(
        (row) =>
          row.productId === target.productId &&
          (target.sourceOrderId === null || row.id === target.sourceOrderId),
      );
      return source ? [source] : [];
    }),
  );
  const preferredBrowserAccountId =
    preferences.length === targets.length &&
    preferences.every((id) => id === preferences[0])
      ? (preferences[0] ?? undefined)
      : undefined;
  const admitted = await startProductResearch(db, {
    ledgerPartyId,
    userId: userId.parse(member.userId),
    productIds: targets.map((target) => target.productId),
    selectedSources: targets.flatMap((target) =>
      target.sourceOrderId === null
        ? []
        : [
            {
              productId: target.productId,
              sourceOrderId: target.sourceOrderId,
            },
          ],
    ),
    preferredBrowserAccountId,
    cause: "member_request",
  });
  const runs = await Promise.all(
    admitted.map(
      async (entry): Promise<TargetedImportStartOutput["runs"][number]> => {
        const [saved] = await getDb(db)
          .select()
          .from(run)
          .where(
            and(
              eq(run.id, entry.runId),
              eq(run.ledgerPartyId, ledgerPartyId),
              notDeleted(run),
            ),
          )
          .limit(1);
        if (!saved)
          throw new Error("Admitted Product research Run is unavailable.");
        return entry.created
          ? {
              created: true,
              run: {
                id: runShortcode.parse(saved.shortcode),
                status: entry.status,
                purpose: "product_enrichment",
                dispatchEventId: saved.dispatchEventId,
              },
              blockingRun: null,
            }
          : {
              created: false,
              run: null,
              blockingRun: {
                id: runShortcode.parse(saved.shortcode),
                status: entry.status,
              },
            };
      },
    ),
  );
  return { runs };
}

/** Admit and dispatch explicit research using the shared durable runtime. */
export async function startTargetedImport(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  input: TargetedImportStartInput,
): Promise<TargetedImportStartOutput> {
  if (input.purpose === "account_sync") {
    const admission = await admitVendorResearch(
      db,
      ledgerPartyId,
      input.vendorId,
    );
    const row = admission.run;
    const status =
      row.dispatchEventId &&
      (admission.created ||
        row.status === "dispatch_failed" ||
        (row.status === "running" && row.dispatchAttempts === 0))
        ? await dispatchStartedRun(db, {
            id: row.id,
            eventId: row.dispatchEventId,
            purpose: row.purpose,
          })
        : row.status;
    return {
      runs: [
        {
          created: admission.created,
          run: {
            id: runShortcode.parse(row.shortcode),
            status,
            purpose: "account_sync",
            dispatchEventId: row.dispatchEventId,
          },
          blockingRun: null,
        },
      ],
    };
  }
  return input.purpose === "purchase_validation"
    ? startPurchaseValidation(db, ledgerPartyId, input)
    : startProductEnrichment(db, ledgerPartyId, input);
}
