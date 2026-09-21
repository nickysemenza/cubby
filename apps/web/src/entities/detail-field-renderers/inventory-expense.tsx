import {
  expenseShortcode,
  inventoryShortcode,
  productShortcode,
} from "@cubby/schemas/identifiers";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { DetailRecordOf } from "~/app/_components/entity-detail/detail-record";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { expense } from "~/app/expenses/expense.functions";
import { Button } from "~/components/ui/button";
import { entityListFor } from "~/entities/entity-list.functions";

import { expenseCaptureRequest } from "../editing/editor-requests";
import { EntityEditDialog } from "../editing/entity-edit-dialog";

export function InventoryExpenseActions({
  record,
}: {
  record: DetailRecordOf<"inventory">;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const inventoryEntryId = inventoryShortcode.parse(record.id);
  const productId = productShortcode.parse(record.product.id);
  const context = useQuery(
    expense.inventoryOwnershipContext.queryOptions({ inventoryEntryId }),
  );
  const expenses = useQuery(
    entityListFor("expense").queryOptions({
      filters: { productId },
      pagination: { pageIndex: 0, pageSize: 100 },
    }),
  );
  const confirm = useActionMutation({
    mutationFn: expense.confirmInventoryBeneficiary.mutationOptions,
    success: "Expense beneficiary saved",
  });
  const owner = context.data?.effectiveOwnership.effectiveOwner;
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="text-sm">
        Record a purchase or sale with the existing expense form. Use a negative
        cost for sale proceeds; inventory removal remains a separate action.
      </p>
      {owner ? (
        <p className="text-xs text-muted-foreground">
          Suggested beneficiary: {owner.name}. This does not assign a funder.
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        disabled={!context.data}
        onClick={() => setOpen(true)}
      >
        Record expense
      </Button>
      <EntityEditDialog
        open={open}
        onOpenChange={setOpen}
        request={expenseCaptureRequest({
          productId,
          beneficiaries: context.data?.suggestedBeneficiaries ?? [],
        })}
      />
      {owner && expenses.data?.items.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Existing expense to attribute"
            className="rounded border bg-background p-2 text-sm"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">Choose existing expense</option>
            {expenses.data.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {item.date} · {item.cost}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={!selected || confirm.isPending}
            onClick={() => {
              if (!context.data) return;
              confirm.mutate({
                inventoryEntryId,
                expenseId: expenseShortcode.parse(selected),
                evidenceFingerprint:
                  context.data.effectiveOwnership.evidenceFingerprint,
              });
            }}
          >
            Confirm {owner.name} as beneficiary
          </Button>
        </div>
      ) : null}
      {context.error ? (
        <p role="alert">Unable to load ownership evidence.</p>
      ) : null}
    </div>
  );
}
