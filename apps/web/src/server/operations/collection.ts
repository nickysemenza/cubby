import {
  collectionDefinitionForReference,
  type collectionCreateInput,
  type collectionDetailInput,
  type collectionTagSetInput,
} from "@cubby/schemas/collection";
import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityRef } from "@cubby/schemas/identifiers";
import type { z } from "zod";

import { collectionContract } from "~/contracts/collection.contract";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  getCollectionDetail,
  getCollectionMatrix,
  getSmartCollectionDetail,
  listCollections,
  listSmartCollections,
  setCollectionAssignment,
} from "~/server/repo/collection";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

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
  const detail = await getCollectionDetail(
    context.db,
    input.collection,
    input.search,
    input.pagination,
  );
  if (!detail)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `Collection not found: ${input.collection}`,
    );
  return detail;
}

const runCollectionEffects = async (
  context: CollectionWorkflowContext,
  entity: Awaited<ReturnType<typeof setCollectionAssignment>>,
) =>
  runMutationSideEffectsForEntities(context.db, [
    {
      action: "updated",
      entity: parseEntityRef<"product" | "location">(
        entity.entityKind,
        entity.entityId,
      ),
      source:
        entity.entityKind === "product" ? "product.update" : "location.update",
    },
  ]);

export const setCollectionMembership = bindWorkflow(
  workflow<CollectionWorkflowContext, z.output<typeof collectionTagSetInput>>(
    "collection.membership.set",
  )
    .commit("assigned", async ({ context }, { input }) =>
      setCollectionAssignment(context.db, context.actorContext, input),
    )
    .effect("effects", async ({ context }, { assigned }) =>
      runCollectionEffects(context, assigned),
    )
    .output(({ input }) => ({
      collection: input.collection,
      assigned: input.assigned,
    })),
);

export const createCollection = bindWorkflow(
  workflow<CollectionWorkflowContext, z.output<typeof collectionCreateInput>>(
    "collection.create",
  )
    .commit("assigned", async ({ context }, { input }) =>
      setCollectionAssignment(context.db, context.actorContext, {
        ...input,
        assigned: true,
      }),
    )
    .effect("effects", async ({ context }, { assigned }) =>
      runCollectionEffects(context, assigned),
    )
    .call("summaries", async ({ context }) => listCollections(context.db))
    .output(({ input, summaries }) => {
      const summary = summaries.find((item) => item.slug === input.collection);
      if (!summary) throw new Error("Created Collection did not resolve");
      return summary;
    }),
);

export const collectionHandlers = implementOperationDomain(collectionContract, {
  referenceDetail: (context, input) =>
    getSmartCollectionDetail(
      context.db,
      collectionDefinitionForReference(input.reference),
      input.search,
      input.pagination,
    ),
  smartList: (context, input) =>
    listSmartCollections(context.db, input.definitions),
  smartDetail: (context, input) =>
    getSmartCollectionDetail(
      context.db,
      input.definition,
      input.search,
      input.pagination,
    ),
  list: listCollectionSummaries,
  detail: readCollectionDetail,
  matrix: (context, input) =>
    getCollectionMatrix(
      context.db,
      input.subject,
      input.search,
      input.sort,
      input.collection,
      input.membership,
      input.pagination,
    ),
  set: setCollectionMembership,
  create: createCollection,
});
