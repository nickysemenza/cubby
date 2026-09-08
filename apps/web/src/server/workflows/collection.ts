import type {
  collectionCreateInput,
  collectionDetailInput,
  collectionMatrixInput,
  collectionTagSetInput,
} from "@cubby/schemas/collection";
import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import type { z } from "zod";

import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  getCollectionDetail,
  getCollectionMatrix,
  listCollections,
  setCollectionAssignment,
} from "~/server/repo/collection";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";

export type CollectionWorkflowContext = {
  db: Database;
  actorContext: ActorContext;
};

export const listCollectionSummaries = (context: CollectionWorkflowContext) =>
  listCollections(context.db);

export async function readCollectionDetail(
  context: CollectionWorkflowContext,
  input: z.output<typeof collectionDetailInput>,
) {
  const result = await getCollectionDetail(
    context.db,
    input.collection,
    input.search,
    input.pagination,
  );
  if (!result) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Collection not found: ${input.collection}`,
    );
  }
  return result;
}

export const readCollectionMatrix = (
  context: CollectionWorkflowContext,
  input: z.output<typeof collectionMatrixInput>,
) =>
  getCollectionMatrix(
    context.db,
    input.subject,
    input.search,
    input.sort,
    input.collection,
    input.membership,
    input.pagination,
  );

async function setCollectionTag(
  context: CollectionWorkflowContext,
  input: z.output<typeof collectionTagSetInput>,
) {
  const entity = await setCollectionAssignment(
    context.db,
    context.actorContext,
    input,
  );
  await runMutationSideEffectsForEntities(context.db, [
    {
      action: "updated",
      entity: parseEntityRef<"product" | "location">(
        entity.entityType,
        entity.entityId,
      ),
      source:
        entity.entityType === "product" ? "product.update" : "location.update",
    },
  ]);
}

export async function setCollectionMembership(
  context: CollectionWorkflowContext,
  input: z.output<typeof collectionTagSetInput>,
) {
  await setCollectionTag(context, input);
  return { collection: input.collection, assigned: input.assigned };
}

export async function createCollection(
  context: CollectionWorkflowContext,
  input: z.output<typeof collectionCreateInput>,
) {
  await setCollectionTag(context, { ...input, assigned: true });
  const summary = (await listCollections(context.db)).find(
    (item) => item.slug === input.collection,
  );
  if (!summary) throw new Error("Created Collection did not resolve");
  return summary;
}
