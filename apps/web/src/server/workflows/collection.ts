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
import {
  bindWorkflow,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

export type CollectionWorkflowContext = {
  db: Database;
  actorContext: ActorContext;
};

export const listCollectionSummaries = defineWorkflowOperation(
  "collection.list",
  async (context: CollectionWorkflowContext) => listCollections(context.db),
);

export const readCollectionDetail = bindWorkflow(
  workflow<CollectionWorkflowContext, z.output<typeof collectionDetailInput>>(
    "collection.detail",
  )
    .call("read", async ({ context }, { input }) =>
      getCollectionDetail(
        context.db,
        input.collection,
        input.search,
        input.pagination,
      ),
    )
    .output(({ read, input }) => {
      if (!read)
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `Collection not found: ${input.collection}`,
        );
      return read;
    }),
  (
    context: CollectionWorkflowContext,
    input: z.output<typeof collectionDetailInput>,
  ) => ({ context, input }),
);

export const readCollectionMatrix = defineWorkflowOperation(
  "collection.matrix",
  async (
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
    ),
);

const runCollectionEffects = async (
  context: CollectionWorkflowContext,
  entity: Awaited<ReturnType<typeof setCollectionAssignment>>,
) =>
  runMutationSideEffectsForEntities(context.db, [
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
  (
    context: CollectionWorkflowContext,
    input: z.output<typeof collectionTagSetInput>,
  ) => ({
    context,
    input,
  }),
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
  (
    context: CollectionWorkflowContext,
    input: z.output<typeof collectionCreateInput>,
  ) => ({
    context,
    input,
  }),
);
