import { entityFieldModels } from "@cubby/schemas/entity-fields";

import { renderDetailFieldValue } from "~/entity/display/entity-display";
import { Stack } from "~/ui/layout";

import type { EntityDetailFieldRenderers } from "./index";
import { InventoryExpenseActions } from "./inventory-expense";

const ownerField = entityFieldModels.inventory.fields.find(
  (field) => field.key === "ownerLedgerPartyId",
);

export const inventoryDetailFields = {
  // The owner reads and edits generically; it also hosts the purchase or
  // sale evidence that owner inference draws on.
  ownerLedgerPartyId: (record) => ({
    value: (
      <Stack gap="sm">
        {ownerField
          ? renderDetailFieldValue("inventory", record, ownerField)
          : null}
        <details className="max-w-2xl">
          <summary className="cursor-pointer text-xs font-medium">
            Purchase or sale evidence
          </summary>
          <InventoryExpenseActions record={record} />
        </details>
      </Stack>
    ),
  }),
} satisfies EntityDetailFieldRenderers<"inventory">;
