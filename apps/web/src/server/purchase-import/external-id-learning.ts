import type { ExternalIdKind } from "@cubby/schemas/external-id";
import { parseEntityId, type ProductId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { entityExternalId } from "~/server/db/schema";
import { notDeleted } from "~/server/repo/database-helpers";
import { ensureExternalSources } from "~/server/repo/entity-external-ids";

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
  const existing = await tx.query.entityExternalId.findFirst({
    where: and(
      eq(entityExternalId.source, source),
      eq(entityExternalId.kind, input.kind),
      eq(entityExternalId.externalId, input.externalId),
      notDeleted(entityExternalId),
    ),
  });

  if (existing) {
    if (existing.entityId !== input.productId) {
      throw new PurchaseProductExternalIdCollisionError({
        source,
        kind: input.kind,
        externalId: input.externalId,
        ownerProductId: parseEntityId("product", existing.entityId),
      });
    }
    return "already_present";
  }

  const primary = await tx.query.entityExternalId.findFirst({
    where: and(
      eq(entityExternalId.entityId, input.productId),
      eq(entityExternalId.source, source),
      eq(entityExternalId.kind, input.kind),
      eq(entityExternalId.isPrimary, true),
      notDeleted(entityExternalId),
    ),
    columns: { id: true },
  });

  await ensureExternalSources(tx, [source]);
  const [inserted] = await tx
    .insert(entityExternalId)
    .values({
      entityId: input.productId,
      entityKind: "product" as const,
      source,
      kind: input.kind,
      externalId: input.externalId,
      url: input.url ?? null,
      isPrimary: primary === undefined,
    })
    .onConflictDoNothing()
    .returning({ id: entityExternalId.id });

  if (inserted) return "learned";

  // Another transaction may have won either unique-index race. Re-read the
  // global identifier first so an identifier claimed by another Product is
  // never reinterpreted as a harmless primary-slot race.
  const winner = await tx.query.entityExternalId.findFirst({
    where: and(
      eq(entityExternalId.source, source),
      eq(entityExternalId.kind, input.kind),
      eq(entityExternalId.externalId, input.externalId),
      notDeleted(entityExternalId),
    ),
  });
  if (winner?.entityId === input.productId) return "already_present";
  if (winner) {
    throw new PurchaseProductExternalIdCollisionError({
      source,
      kind: input.kind,
      externalId: input.externalId,
      ownerProductId: parseEntityId("product", winner.entityId),
    });
  }

  // A different identifier may have become this slot's primary after our
  // read. Preserve this identifier as a secondary instead of asking the whole
  // import to retry. The global unique index remains the final ownership guard.
  const [secondary] = await tx
    .insert(entityExternalId)
    .values({
      entityId: input.productId,
      entityKind: "product" as const,
      source,
      kind: input.kind,
      externalId: input.externalId,
      url: input.url ?? null,
      isPrimary: false,
    })
    .onConflictDoNothing()
    .returning({ id: entityExternalId.id });
  if (secondary) return "learned";

  const secondaryWinner = await tx.query.entityExternalId.findFirst({
    where: and(
      eq(entityExternalId.source, source),
      eq(entityExternalId.kind, input.kind),
      eq(entityExternalId.externalId, input.externalId),
      notDeleted(entityExternalId),
    ),
  });
  if (secondaryWinner?.entityId === input.productId) return "already_present";
  if (secondaryWinner) {
    throw new PurchaseProductExternalIdCollisionError({
      source,
      kind: input.kind,
      externalId: input.externalId,
      ownerProductId: parseEntityId("product", secondaryWinner.entityId),
    });
  }
  throw new Error("Product external ID write could not be recorded");
}
