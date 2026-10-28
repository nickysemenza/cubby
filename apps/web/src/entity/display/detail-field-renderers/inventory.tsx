import { useQueryClient } from "@tanstack/react-query";

import { renderDetailFieldValue } from "~/entity/display/entity-display";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { useEntityMetadata } from "~/entity/metadata";
import { Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";

import type { EntityDetailFieldRenderers } from "./index";
import { InventoryExpenseActions } from "./inventory-expense";

function InventoryOwnerField({
  record,
}: {
  record: DetailRecordOf<"inventory">;
}) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata("inventory");
  const ownerField = metadata.fields.fields.find(
    (field) => field.key === "ownerLedgerPartyId",
  );
  return (
    <Stack gap="sm">
      {ownerField
        ? renderDetailFieldValue(queryClient, "inventory", record, ownerField)
        : null}
      <Disclosure
        summary="Purchase or sale evidence"
        className="max-w-2xl"
        keepMounted
      >
        <InventoryExpenseActions record={record} />
      </Disclosure>
    </Stack>
  );
}

export const inventoryDetailFields = {
  // The owner reads and edits generically; it also hosts the purchase or
  // sale evidence that owner inference draws on.
  ownerLedgerPartyId: (record) => ({
    value: <InventoryOwnerField record={record} />,
  }),
} satisfies EntityDetailFieldRenderers<"inventory">;
