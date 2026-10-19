import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  entityKernelContextSchema,
  executeEntityAs,
} from "~/server/entity-kernel";
import { createTestRequestContext } from "~/server/testing/request-context";

describe("allocation detail display", () => {
  const ctx = withTestDb();

  it.each([
    { label: "empty", amounts: [], formatted: [] },
    { label: "single", amounts: [10], formatted: ["$10.00"] },
    { label: "multiple", amounts: [4, 6], formatted: ["$4.00", "$6.00"] },
  ])(
    "declares and returns useful $label allocation rows",
    async ({ amounts, formatted }) => {
      const vendor = await createRepoEntity(ctx, "vendor", {
        name: "Synthetic display vendor",
      });
      const account = await createRepoEntity(ctx, "financialAccount", {
        name: "Synthetic display account",
        identity: { kind: "credit_card", issuer: null, network: "visa" },
        cardNumbers: [],
      });
      const purchases = await Promise.all(
        amounts.map((_amount, index) =>
          createRepoEntity(ctx, "purchase", {
            vendorId: vendor.output.id,
            date: "2026-04-01",
            orderId: `synthetic-display-${index}`,
          }),
        ),
      );
      const allocations = purchases.map((purchase, index) => ({
        purchaseId: purchase.output.id,
        amount: amounts[index]!,
      }));
      const transaction = await createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-04-01",
        amount: 10,
        allocations,
      });
      const context = entityKernelContextSchema.parse(
        createTestRequestContext(ctx.db, {
          auth: { userId: ctx.actor.userId },
        }),
      );
      const result = await executeEntityAs(context, "get", {
        entity: "financialTransaction",
        id: transaction.output.id,
        missing: "error",
      });
      expect(result.item).toMatchObject({
        allocationItems: expect.arrayContaining(
          allocations.map((allocation, index) => ({
            entity: "purchase",
            id: allocation.purchaseId,
            title: allocation.purchaseId,
            subtitle: null,
            trailing: formatted[index],
          })),
        ),
      });
      expect(result.item).toHaveProperty(
        "allocationItems.length",
        amounts.length,
      );
      expect(
        entityFieldModels.financialTransaction.fields.find(
          (field) => field.key === "allocations",
        ),
      ).toMatchObject({ display: { itemsPath: "allocationItems" } });
    },
  );
});
