import type { ExternalIdKind } from "@cubby/schemas/external-id";
import type { ProductId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { productExternalId } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";

export class PurchaseProductExternalIdCollisionError extends Error {
  readonly source: string;
  readonly kind: ExternalIdKind;
  readonly externalId: string;
  readonly ownerProductId: ProductId;

  constructor(input: {
    source: string;
    kind: ExternalIdKind;
    externalId: string;
    ownerProductId: ProductId;
  }) {
    super(
      `Product external ID ${input.source}/${input.kind}/${input.externalId} already belongs to another product`,
    );
    this.name = "PurchaseProductExternalIdCollisionError";
    this.source = input.source;
    this.kind = input.kind;
    this.externalId = input.externalId;
    this.ownerProductId = input.ownerProductId;
  }
}

/**
 * Learn one vendor identifier inside the caller's transaction.
 *
 * The global live identifier unique index is the final race guard. The
 * read-before-write makes that conflict explicit to the import instead of
 * silently treating an identifier owned by a different product as learned.
 */
export async function learnPurchaseProductExternalId(
  tx: DrizzleTransaction,
  input: {
    productId: ProductId;
    source: string;
    kind: ExternalIdKind;
    externalId: string;
    url?: string | null;
  },
): Promise<"learned" | "already_present"> {
  const source = input.source.trim().toLowerCase();
  const existing = await tx.query.productExternalId.findFirst({
    where: and(
      eq(productExternalId.source, source),
      eq(productExternalId.kind, input.kind),
      eq(productExternalId.externalId, input.externalId),
      notDeleted(productExternalId),
    ),
  });

  if (existing) {
    if (existing.productId !== input.productId) {
      throw new PurchaseProductExternalIdCollisionError({
        source,
        kind: input.kind,
        externalId: input.externalId,
        ownerProductId: existing.productId,
      });
    }
    return "already_present";
  }

  const primary = await tx.query.productExternalId.findFirst({
    where: and(
      eq(productExternalId.productId, input.productId),
      eq(productExternalId.source, source),
      eq(productExternalId.kind, input.kind),
      eq(productExternalId.isPrimary, true),
      notDeleted(productExternalId),
    ),
    columns: { id: true },
  });

  const [inserted] = await tx
    .insert(productExternalId)
    .values({
      productId: input.productId,
      source,
      kind: input.kind,
      externalId: input.externalId,
      url: input.url ?? null,
      isPrimary: primary === undefined,
    })
    .onConflictDoNothing()
    .returning({ id: productExternalId.id });

  if (inserted) return "learned";

  // Another transaction may have won either unique-index race. Re-read the
  // global identifier first so an identifier claimed by another Product is
  // never reinterpreted as a harmless primary-slot race.
  const winner = await tx.query.productExternalId.findFirst({
    where: and(
      eq(productExternalId.source, source),
      eq(productExternalId.kind, input.kind),
      eq(productExternalId.externalId, input.externalId),
      notDeleted(productExternalId),
    ),
  });
  if (winner?.productId === input.productId) return "already_present";
  if (winner) {
    throw new PurchaseProductExternalIdCollisionError({
      source,
      kind: input.kind,
      externalId: input.externalId,
      ownerProductId: winner.productId,
    });
  }

  // A different identifier may have become this slot's primary after our
  // read. Preserve this identifier as a secondary instead of asking the whole
  // import to retry. The global unique index remains the final ownership guard.
  const [secondary] = await tx
    .insert(productExternalId)
    .values({
      productId: input.productId,
      source,
      kind: input.kind,
      externalId: input.externalId,
      url: input.url ?? null,
      isPrimary: false,
    })
    .onConflictDoNothing()
    .returning({ id: productExternalId.id });
  if (secondary) return "learned";

  const secondaryWinner = await tx.query.productExternalId.findFirst({
    where: and(
      eq(productExternalId.source, source),
      eq(productExternalId.kind, input.kind),
      eq(productExternalId.externalId, input.externalId),
      notDeleted(productExternalId),
    ),
  });
  if (secondaryWinner?.productId === input.productId) return "already_present";
  if (secondaryWinner) {
    throw new PurchaseProductExternalIdCollisionError({
      source,
      kind: input.kind,
      externalId: input.externalId,
      ownerProductId: secondaryWinner.productId,
    });
  }
  throw new Error("Product external ID write could not be recorded");
}
