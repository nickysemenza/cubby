import { entityFieldModels } from "@cubby/schemas/entity-fields";

import { renderDetailFieldValue } from "~/entity/display/entity-display";
import { Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";

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
        <Disclosure
          summary="Purchase or sale evidence"
          className="max-w-2xl"
          keepMounted
        >
          <InventoryExpenseActions record={record} />
        </Disclosure>
      </Stack>
    ),
  }),
} satisfies EntityDetailFieldRenderers<"inventory">;
