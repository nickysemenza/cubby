import { actionAvailabilityRules } from "@cubby/schemas/action-availability";
import { expenseFieldEnvelopeSchemas } from "@cubby/schemas/compiler/generated/entity-field-envelopes/expense";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { expenseShortcode } from "@cubby/schemas/identifiers";
import { useState } from "react";
import { z } from "zod";

import { VerbMenuItem } from "~/entity/actions/action-verb-ui";
import { defineEntityAction } from "~/entity/actions/entity-action-definition";
import type {
  EntityActionHandles,
  EntityActionResolutionContext,
  EntityActionRow,
} from "~/entity/actions/entity-actions";

import { ReceiveExpenseDialog } from "./receive-expense-dialog";

const NO_PRODUCT = actionAvailabilityRules.receive.requires.reason;

const receivableRow = z.object({
  id: expenseShortcode,
  name: z.string(),
  productName: z.string().nullish(),
  fields: expenseFieldEnvelopeSchemas.list.shape.fields.pick({
    productId: true,
  }),
});

const asReceivable = (row: EntityActionRow) => {
  const parsed = receivableRow.safeParse(row);
  if (!parsed.success) return null;
  const productId = fieldValueOf(parsed.data.fields.productId);
  return { ...parsed.data, productId };
};
type Receivable = NonNullable<ReturnType<typeof asReceivable>>;

/**
 * "Receive into inventory" from an Expense row or page: the same dialog the
 * settlement section opens. Receiving stays an explicit act; linking a Product
 * never moves stock on its own.
 */
function useReceiveExpenseAction(): EntityActionHandles {
  const [target, setTarget] = useState<Receivable | null>(null);
  const stage = (row: EntityActionRow) => {
    const expense = asReceivable(row);
    if (expense?.productId) setTarget(expense);
    return Boolean(expense?.productId);
  };
  return {
    run: async (rows) => ({
      success: rows.length === 1 && rows[0] !== undefined && stage(rows[0]),
    }),
    availability: ({ rows }: EntityActionResolutionContext) => {
      const expense =
        rows.length === 1 && rows[0] ? asReceivable(rows[0]) : null;
      if (!expense) return { status: "hidden" };
      return expense.productId
        ? { status: "available" }
        : { status: "disabled", reason: NO_PRODUCT };
    },
    rowMenuItem: (row) => {
      const expense = asReceivable(row);
      if (!expense) return null;
      return (
        <VerbMenuItem
          verb="receive"
          disabledReason={expense.productId ? undefined : NO_PRODUCT}
          onSelect={(event) => {
            event.stopPropagation();
            stage(row);
          }}
        />
      );
    },
    dialog: target?.productId ? (
      <ReceiveExpenseDialog
        open
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        productId={target.productId}
        productName={target.productName ?? target.productId}
        expenseName={target.name}
        expenseId={target.id}
      />
    ) : null,
  };
}

export const receiveExpenseActionDefinition = defineEntityAction({
  verb: "receive",
  entities: ["expense"],
  arity: "single",
  surfaces: ["row", "inspector", "detail"],
  group: "primary",
  priority: 45,
  readFields: ["name", "productId"],
  use: useReceiveExpenseAction,
});
