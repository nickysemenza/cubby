import type { BackgroundTaskInput } from "@cubby/schemas/background-tasks";
import { ingredientShortcode } from "@cubby/schemas/identifiers";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it } from "vitest";

import {
  entitySummaryResultSchema,
  projectEntityResult,
} from "~/contracts/mcp-projections";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import { findOrCreateIngredient } from "~/server/domains/ingredient/repo/crud";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import {
  generatedMcpEntityMutationCreateResultSchema,
  generatedMcpEntityMutationUpdateResultSchema,
} from "~/server/generated/entity-bindings.gen";
import { createMcpServer } from "~/server/mcp/server";
import {
  callMcpTool,
  kernelRequestContext,
} from "~/server/testing/mcp-test-utils";
import {
  makeProductInput,
  makeRecipeInput,
  ingredientRef,
  createRecipeFixture,
} from "~/server/testing/repo.fixtures";
import { createTestRequestContext } from "~/server/testing/request-context";

const requireMutationSuccess = (
  result: Awaited<ReturnType<typeof callMcpTool>>,
) => {
  if (result.isError) throw new Error(JSON.stringify(result));
};

// Failure modes: a narrow mutation response loses coverage or identity fields,
// changes audit/search effects, or silently returns a different summary from
// the canonical full result. SQL counts remain independent AI-review evidence.
describe("mutation response demand", () => {
  const ctx = withTestDb("mcp");
  afterEach(() => setCfEnv(undefined));

  // Ingredient identity is needed by a side effect even when the response omits it.
  it("publishes recipe recomputation after summary and full Product writes commit", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    for (const resultDetail of ["summary", "full"] as const) {
      const ingredient = await findOrCreateIngredient(
        ctx.db,
        `Synthetic ${resultDetail} costing ingredient`,
      );
      if (!ingredient)
        throw new Error("Synthetic costing ingredient was not created");
      const recipe = await createRecipeFixture(
        ctx.db,
        makeRecipeInput({
          name: `Synthetic ${resultDetail} costing recipe`,
          sections: [
            {
              name: "Synthetic section",
              ingredients: [
                ingredientRef(ingredient.shortcode, {
                  amounts: [{ value: 1, unit: "whole" }],
                }),
              ],
              instructions: [
                { instruction: "Combine the synthetic ingredients." },
              ],
            },
          ],
        }),
        ctx.actor,
      );
      const published: BackgroundTaskInput[] = [];
      let expectedName = `Synthetic ${resultDetail} costing product`;
      setCfEnv(
        fromPartial<Env>({
          BACKGROUND_QUEUE: {
            send: async () => {},
            sendBatch: async (
              messages: Iterable<{ body: { task: BackgroundTaskInput } }>,
            ) => {
              for (const { body } of messages) {
                if (body.task.kind !== "recipe-totals.recompute") continue;
                // The queue consumer uses a fresh connection, outside the write transaction.
                const visible = await getDb(ctx.db).query.product.findFirst({
                  where: eq(product.name, expectedName),
                  columns: { name: true },
                });
                expect(visible?.name).toBe(expectedName);
                published.push(body.task);
              }
            },
          },
        }),
      );
      const created = await callMcpTool(
        createMcpServer(),
        "entity",
        {
          action: "create",
          entity: "product",
          resultDetail,
          data: makeProductInput({
            name: expectedName,
            ingredientId: ingredientShortcode.parse(ingredient.shortcode),
            price: 2,
          }),
        },
        kernelRequestContext(context),
        { entityKernel: context },
      );
      requireMutationSuccess(created);
      expect(published).toMatchObject([
        { kind: "recipe-totals.recompute", recipeIds: [recipe.entityId] },
      ]);
      const identity = entitySummaryResultSchema.parse(
        resultDetail === "full"
          ? projectEntityResult(
              { resultDetail: "summary" },
              generatedMcpEntityMutationCreateResultSchema.parse(
                created.structuredContent,
              ),
            )
          : created.structuredContent,
      ).item?.id;
      if (!identity)
        throw new Error("Synthetic costing Product has no identity");
      published.length = 0;
      expectedName = `Synthetic ${resultDetail} renamed costing product`;
      const updated = await callMcpTool(
        createMcpServer(),
        "entity",
        {
          action: "update",
          entity: "product",
          id: identity,
          data: { name: expectedName },
          resultDetail,
        },
        kernelRequestContext(context),
        { entityKernel: context },
      );
      requireMutationSuccess(updated);
      expect(published).toMatchObject([
        { kind: "recipe-totals.recompute", recipeIds: [recipe.entityId] },
      ]);
    }
  });

  it("preserves summary coverage and stored effects for Task and Product writes", async () => {
    const context = entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
    const summaries = new Map<string, unknown>();
    for (const entity of ["task", "product"] as const) {
      for (const resultDetail of ["summary", "full"] as const) {
        const name = `Synthetic ${resultDetail} mutation projection ${entity}`;
        const created = await callMcpTool(
          createMcpServer(),
          "entity",
          {
            action: "create",
            entity,
            resultDetail,
            data:
              entity === "task"
                ? { name, trade: "other" }
                : makeProductInput({
                    name,
                    externalIds: [
                      {
                        source: "gtin",
                        kind: "gtin_14",
                        externalId:
                          resultDetail === "summary"
                            ? "02900000000018"
                            : "02900000000025",
                      },
                    ],
                  }),
          },
          kernelRequestContext(context),
          { entityKernel: context },
        );
        requireMutationSuccess(created);
        const createdSummary = entitySummaryResultSchema.parse(
          resultDetail === "full"
            ? projectEntityResult(
                { resultDetail: "summary" },
                generatedMcpEntityMutationCreateResultSchema.parse(
                  created.structuredContent,
                ),
              )
            : created.structuredContent,
        );
        const id = createdSummary.item?.id;
        if (!id) throw new Error("Synthetic create did not return an identity");
        const updatedName = `Synthetic ${resultDetail} renamed projection ${entity}`;
        const updated = await callMcpTool(
          createMcpServer(),
          "entity",
          {
            action: "update",
            entity,
            id,
            data: { name: updatedName },
            resultDetail,
          },
          kernelRequestContext(context),
          { entityKernel: context },
        );
        requireMutationSuccess(updated);
        const updatedSummary = entitySummaryResultSchema.parse(
          resultDetail === "full"
            ? projectEntityResult(
                { resultDetail: "summary" },
                generatedMcpEntityMutationUpdateResultSchema.parse(
                  updated.structuredContent,
                ),
              )
            : updated.structuredContent,
        );
        for (const [action, summary] of [
          ["create", createdSummary],
          ["update", updatedSummary],
        ] as const) {
          expect(summary.item?.coverage).toBeDefined();
          expect(summary.item?.externalIds?.length).toBe(
            entity === "product" ? 1 : undefined,
          );
          summaries.set(
            `${entity}:${action}:${resultDetail}`,
            JSON.parse(
              JSON.stringify(summary)
                .replaceAll(id, "SYNTHETIC-ID")
                .replaceAll("Synthetic summary", "Synthetic")
                .replaceAll("Synthetic full", "Synthetic")
                .replaceAll("02900000000018", "SYNTHETIC-GTIN")
                .replaceAll("02900000000025", "SYNTHETIC-GTIN"),
            ),
          );
        }
        const stored = await getDb(ctx.db).execute(sql`SELECT document.title,
          (SELECT count(*)::int FROM "AuditLog" audit
            WHERE audit."entityKind"=identity.kind AND audit."entityId"=identity.id) AS audits
          FROM "Entity" identity JOIN "SearchDocument" document
            ON document."entityKind"=identity.kind AND document."entityId"=identity.id
          WHERE identity.shortcode=${id} AND identity.kind=${entity}`);
        expect(stored.rows).toEqual([{ title: updatedName, audits: 2 }]);
      }
      for (const action of ["create", "update"])
        expect(summaries.get(`${entity}:${action}:summary`)).toEqual(
          summaries.get(`${entity}:${action}:full`),
        );
    }
  });
});
