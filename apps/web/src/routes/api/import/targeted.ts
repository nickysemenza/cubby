import type {
  LedgerPartyId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import { vendorAccountId } from "@cubby/schemas/identifiers";
import { createFileRoute } from "@tanstack/react-router";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import {
  targetedImportError,
  targetedImportLaunchResponse,
  targetedImportPurpose,
  targetedImportStartResponse,
  purchaseValidationStartInput,
  productEnrichmentStartInput,
} from "~/lib/targeted-import-api";
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
import { recordImportRunDispatchAttempt } from "~/server/purchase-import/dispatch";
import { productEnrichmentTarget } from "~/server/purchase-import/product-enrichment-target";
import { startTargetedImportRun } from "~/server/purchase-import/run-service";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { createRequestContext, requireActor } from "~/server/request-context";

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

const launchNotFound = () =>
  Response.json({ error: "Target was not found" }, { status: 404 });

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

async function queueStartedRun(
  db: Parameters<typeof recordImportRunDispatchAttempt>[0],
  run: {
    id: string;
    publicId: string;
    status: string;
    purpose: string;
    dispatchEventId: string | null;
  },
) {
  const queue = getPurchaseAgentQueue();
  if (!run.dispatchEventId)
    throw new Error("Targeted import run has no dispatch event");
  if (!queue) {
    await recordImportRunDispatchAttempt(db, {
      runId: run.id,
      eventId: run.dispatchEventId,
      error: "Purchase import agent queue is unavailable",
    });
    return { ...run, status: "dispatch_failed" };
  }
  try {
    await queue.send({
      version: 1,
      runId: run.id,
      purpose: targetedImportPurpose.parse(run.purpose),
      eventId: run.dispatchEventId,
      type: "start_or_resume",
    });
    await recordImportRunDispatchAttempt(db, {
      runId: run.id,
      eventId: run.dispatchEventId,
    });
    return { ...run, status: "running" };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Queue send failed";
    await recordImportRunDispatchAttempt(db, {
      runId: run.id,
      eventId: run.dispatchEventId,
      error: message,
    });
    return { ...run, status: "dispatch_failed" };
  }
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

export const Route = createFileRoute("/api/import/targeted")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const party = await context.currentParty();
        if (!party)
          return Response.json(
            { error: "Member identity is not configured" },
            { status: 403 },
          );
        const url = new URL(request.url);
        const purpose = targetedImportPurpose.safeParse(
          url.searchParams.get("purpose"),
        );
        const targetId = url.searchParams.get("targetId");
        if (!purpose.success || !targetId)
          return Response.json(
            { error: "Purpose and target are required" },
            { status: 400 },
          );

        if (purpose.data === "purchase_validation") {
          const purchaseId = await resolveOrThrow(
            context.db,
            "purchase",
            targetId,
          ).catch(() => null);
          if (!purchaseId) return launchNotFound();
          const [target] = await getDb(context.db)
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
          if (!target) return launchNotFound();
          const claims = await claimsForPurchase(
            context.db,
            party.id,
            purchaseId,
          );
          return Response.json(
            targetedImportLaunchResponse.parse({
              purpose: purpose.data,
              purchase: {
                id: target.shortcode,
                label:
                  target.displayLabel ?? target.orderId ?? target.vendorName,
                canValidate: true,
                reason:
                  claims.length > 0
                    ? null
                    : "No replayable claim exists; the run will search Gmail, then use an owned browser account when available.",
                sources: claims.map((claim, index) => ({
                  id: claim.id,
                  label: `${claim.kind.replaceAll("_", " ")} · ${claim.externalKey}`,
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
            }),
          );
        }

        const productId = await resolveOrThrow(
          context.db,
          "product",
          targetId,
        ).catch(() => null);
        if (!productId) return launchNotFound();
        const [target] = await getDb(context.db)
          .select({ name: product.name })
          .from(product)
          .where(and(eq(product.id, productId), notDeleted(product)))
          .limit(1);
        if (!target) return launchNotFound();
        const [claim] = await getDb(context.db)
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
              eq(importSourceClaim.ledgerPartyId, party.id),
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
        return Response.json(
          targetedImportLaunchResponse.parse({
            purpose: purpose.data,
            purchase: null,
            products: [
              {
                productId: targetId,
                productName: target.name,
                selected: Boolean(claim),
                sourceId: claim?.id ?? null,
                sourceLabel: claim
                  ? `${claim.kind.replaceAll("_", " ")} · ${claim.externalKey}`
                  : null,
                vendorAccountId: claim?.vendorAccountId ?? null,
                vendorAccountLabel: claim?.vendorAccountLabel ?? null,
                needsAccountChoice: false,
                accountChoices: [],
                reason: claim
                  ? null
                  : "No verified purchase source is available.",
              },
            ],
          }),
        );
      },
      // eslint-disable-next-line complexity -- One admission boundary validates both targeted purposes before grouping and dispatch.
      POST: async ({ request }) => {
        const context = requireActor(
          await createRequestContext({ headers: request.headers }),
        );
        const party = await context.currentParty();
        if (!party)
          return Response.json(
            { error: "Member identity is not configured" },
            { status: 403 },
          );
        const body: unknown = await request.json();
        const validation = purchaseValidationStartInput.safeParse(body);
        const enrichment = productEnrichmentStartInput.safeParse(body);
        if (!validation.success && !enrichment.success)
          return Response.json(
            { error: "Targeted import request is invalid" },
            { status: 400 },
          );

        try {
          if (validation.success) {
            const purchaseId = await resolveOrThrow(
              context.db,
              "purchase",
              validation.data.purchaseId,
            );
            const claim = validation.data.sourceId
              ? await claimForActor(
                  context.db,
                  party.id,
                  validation.data.sourceId,
                )
              : null;
            if (claim && claim.purchaseId !== purchaseId)
              return Response.json(
                { error: "Choose a current replayable source" },
                { status: 409 },
              );
            const [purchaseScope] = await getDb(context.db)
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
              return Response.json(
                { error: "Purchase needs a Vendor and order ID" },
                { status: 409 },
              );
            const accountId = claim?.vendorAccountId
              ? vendorAccountId.parse(claim.vendorAccountId)
              : purchaseScope.vendorAccountId
                ? vendorAccountId.parse(purchaseScope.vendorAccountId)
                : null;
            const started = await startTargetedImportRun(context.db, {
              ledgerPartyId: party.id,
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
                  sourceExternalKey:
                    claim?.externalKey ?? purchaseScope.orderId,
                  targetFingerprint: await fingerprint({
                    purchaseId,
                    updatedAt: purchaseScope.updatedAt,
                    source: claim?.outputFingerprint ?? null,
                  }),
                  evidenceFingerprint: claim?.checksum ?? null,
                },
              ],
            });
            const run = started.created
              ? await queueStartedRun(context.db, started.run)
              : null;
            return Response.json(
              targetedImportStartResponse.parse({
                runs: [{ ...started, run }],
              }),
            );
          }

          if (!enrichment.success)
            return Response.json(
              { error: "Product enrichment request is invalid" },
              { status: 400 },
            );
          const targets = enrichment.data.targets;
          const resolved = await Promise.all(
            targets.map(async (target) => {
              const productId = await resolveOrThrow(
                context.db,
                "product",
                target.productId,
              );
              const claim = target.sourceId
                ? await claimForActor(context.db, party.id, target.sourceId)
                : null;
              const productState = await productEnrichmentTarget(
                getDb(context.db),
                productId,
              );
              const [sourceLine] = claim?.purchaseId
                ? await getDb(context.db)
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
              return {
                target,
                productId,
                claim,
                sourceMatches: Boolean(sourceLine),
                targetFingerprint:
                  productState?.fingerprint ??
                  (await fingerprint({ product: undefined })),
              };
            }),
          );
          if (
            resolved.some(
              ({ claim, sourceMatches }) => !claim || !sourceMatches,
            )
          )
            return Response.json(
              {
                error: "Every product needs a verified source that contains it",
              },
              { status: 409 },
            );
          const groups = new Map<string, typeof resolved>();
          for (const row of resolved) {
            const claim = row.claim!;
            const key = `${claim.vendorId}:${claim.vendorAccountId ?? "none"}`;
            const group = groups.get(key);
            if (group) group.push(row);
            else groups.set(key, [row]);
          }
          const runs = await Promise.all(
            [...groups.values()].map(async (group) => {
              const first = group[0]!;
              const claim = first.claim!;
              const accountId = claim.vendorAccountId
                ? vendorAccountId.parse(claim.vendorAccountId)
                : null;
              const started = await startTargetedImportRun(context.db, {
                ledgerPartyId: party.id,
                purpose: "product_enrichment",
                vendorId: claim.vendorId,
                vendorAccountId: accountId,
                trigger: "manual",
                targets: group.map((row) => ({
                  kind: "product" as const,
                  productId: row.productId,
                  vendorAccountId: row.claim!.vendorAccountId
                    ? vendorAccountId.parse(row.claim!.vendorAccountId)
                    : null,
                  sourceKind: row.claim!.kind,
                  sourceExternalKey: row.claim!.externalKey,
                  targetFingerprint: row.targetFingerprint,
                  evidenceFingerprint: row.claim!.checksum,
                })),
              });
              return {
                ...started,
                run: started.created
                  ? await queueStartedRun(context.db, started.run)
                  : null,
              };
            }),
          );
          return Response.json(targetedImportStartResponse.parse({ runs }));
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Targeted import could not start";
          return Response.json(targetedImportError.parse({ error: message }), {
            status: 409,
          });
        }
      },
    },
  },
});
