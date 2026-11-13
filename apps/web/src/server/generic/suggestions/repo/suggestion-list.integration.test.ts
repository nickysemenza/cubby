import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { buildKernelContext } from "tooling/scenarios/context";
import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  suggestionTable,
  financialTransactionAllocation,
  sourceTransactionRecord,
  sourceOccurrence,
  transactionImport,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import {
  sourceObservationColumns,
  sourceObservationFrom,
} from "~/server/domains/transaction-import/repo/source-observation-state";
import { updateSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { recordSourceTransactionRecords } from "~/server/domains/transaction-import/repo/source-transaction-record";
import { answering } from "~/server/domains/transaction-import/repo/statement-decision-port.fixtures";
import * as statementSettlement from "~/server/domains/transaction-import/repo/statement-settlement";
import { generateStatementSuggestionPage } from "~/server/domains/transaction-import/repo/statement-suggestions";
import { labelStatementSuggestions } from "~/server/domains/transaction-import/service/statement-suggestion-labels";
import { executeEntity } from "~/server/entity-kernel";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { readSuggestionRecordRefs } from "~/server/generic/suggestions/repo/suggestion-reference-resolution";
import {
  touchingSuggestionIds,
  touchingSuggestionQuery,
} from "~/server/generic/suggestions/repo/suggestion-touching";
import { buildCrudServices } from "~/server/http/request-context";
import { decide, recordSubject } from "~/server/kernel/api";
import {
  createProductFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

import { listSuggestionPage } from "./suggestion-list";

type Ctx = ReturnType<typeof withTestDb>;

async function fieldSuggestion(
  ctx: Ctx,
  product: { entityId: string },
  field: string,
  confidence: number,
  createdAt: Date,
) {
  const row = await seedFieldSuggestion(
    ctx.db,
    {
      entity: "product",
      recordId: product.entityId,
      field,
      // Cubby disagreeing with a person's value is what the queue lists.
      currentValue: `Synthetic current ${field}`,
      suggestedValue:
        field === "categoryId"
          ? taxonomyShortcode("food")
          : `Synthetic ${field}`,
      confidence,
      model: "typesafe/jev",
      kind: "correction",
      status: "pending",
      createdAt,
    },
    true,
  );
  return row.id;
}

describe("cross-family Suggestion list", () => {
  const ctx = withTestDb();

  // Referenced values remain presentation context, not field subjects.
  it("scopes reference-valued field proposals to their subject", async () => {
    const item = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic reference drill" }),
      ctx.actor,
    );
    const current = await createRepoEntity(ctx, "productCategory", {
      name: "Synthetic current tools",
    });
    const proposed = await createRepoEntity(ctx, "productCategory", {
      name: "Synthetic proposed tools",
    });
    const { id } = await seedFieldSuggestion(ctx.db, {
      entity: "product",
      recordId: item.entityId,
      field: "categoryId",
      currentValue: current.output.id,
      suggestedValue: proposed.output.id,
      confidence: 0.9,
    });
    expect(
      (
        await listSuggestionPage(ctx.db, {
          family: "field",
          recordIds: [item.id],
        })
      ).items.map((row) => row.suggestionId),
    ).toEqual([id]);
    const count = (
      await suggestionCountsByFamily(ctx.db, {
        family: "field",
        recordIds: [item.id],
      })
    ).families.find((row) => row.family === "field");
    expect(count).toMatchObject({
      pending: 1,
      fields: [
        expect.objectContaining({
          entity: "product",
          field: "categoryId",
          pending: 1,
        }),
      ],
    });
    for (const record of [current.output.id, proposed.output.id]) {
      const page = await listSuggestionPage(ctx.db, {
        family: "field",
        recordEntity: "productCategory",
        recordIds: [record],
      });
      expect(page.items.map((row) => row.suggestionId)).toEqual([]);
    }
  });

  // Failure mode: the uniform row recomputes clean and drifts from the
  // statement judgment, letting a sibling charge into bulk accept.

  // Failure mode: bulk accept trusts the ids a client listed, so a charge
  // republished as no longer clean between list and accept is applied.

  // A retained predecessor and later collection must reach the same current charge proposal.
});
