import {
  collectionCreateInput,
  collectionDetailInput,
  collectionDetailOut,
  collectionMatrixInput,
  collectionMatrixOut,
  collectionSummaryOut,
  collectionTagSetInput,
  collectionTagSetOut,
} from "@cubby/schemas/collection";
import type { ActorContext } from "@cubby/schemas/context";
import { z } from "zod";
import type { Database } from "~/server/db";
import { createAppError } from "~/server/errors/app-error";
import {
  getCollectionDetail,
  getCollectionMatrix,
  listCollections,
  setCollectionAssignment,
} from "~/server/repo/collection";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const list = protectedProcedure
  .output(strictOutput(z.array(collectionSummaryOut)))
  .query(({ ctx }) => listCollections(ctx.db));

const detail = protectedProcedure
  .input(collectionDetailInput)
  .output(strictOutput(collectionDetailOut))
  .query(async ({ ctx, input }) => {
    const result = await getCollectionDetail(
      ctx.db,
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
  });

const matrix = protectedProcedure
  .input(collectionMatrixInput)
  .output(strictOutput(collectionMatrixOut))
  .query(({ ctx, input }) =>
    getCollectionMatrix(
      ctx.db,
      input.subject,
      input.search,
      input.sort,
      input.collection,
      input.membership,
      input.pagination,
    ),
  );

const setTag = async (
  ctx: { db: Database; actorContext: ActorContext },
  input: z.infer<typeof collectionTagSetInput>,
) => {
  const entity = await setCollectionAssignment(ctx.db, ctx.actorContext, input);
  await runMutationSideEffectsForEntities(ctx.db, [
    {
      action: "updated",
      entity,
      source:
        entity.entityType === "product" ? "product.update" : "location.update",
    },
  ]);
};

const set = protectedProcedure
  .input(collectionTagSetInput)
  .output(strictOutput(collectionTagSetOut))
  .mutation(async ({ ctx, input }) => {
    await setTag(ctx, input);
    return { collection: input.collection, assigned: input.assigned };
  });

const create = protectedProcedure
  .input(collectionCreateInput)
  .output(strictOutput(collectionSummaryOut))
  .mutation(async ({ ctx, input }) => {
    await setTag(ctx, { ...input, assigned: true });
    const summary = (await listCollections(ctx.db)).find(
      (item) => item.slug === input.collection,
    );
    if (!summary) throw new Error("Created Collection did not resolve");
    return summary;
  });

export const collectionRouter = createTRPCRouter({
  list,
  detail,
  matrix,
  set,
  create,
});
