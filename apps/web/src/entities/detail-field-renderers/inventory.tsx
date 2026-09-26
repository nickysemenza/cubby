import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  type LedgerPartyShortcode,
  ledgerPartyShortcode,
  inventoryShortcode,
} from "@cubby/schemas/identifiers";
import { inventoryOwnershipMode } from "@cubby/schemas/inventory-ownership";
import { useState } from "react";

import { EntityReferencePicker } from "~/app/_components/combobox/entity-reference-picker";
import type { DetailRecordOf } from "~/app/_components/entity-detail/detail-record";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { inventory } from "~/app/inventory/inventory.functions";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import { OverrideControl } from "../editing/override-control";
import { referenceScopeFor } from "../editing/reference-scope";
import type { EntityDetailFieldRenderers } from "./index";
import { InventoryExpenseActions } from "./inventory-expense";

const modeField = entityFieldModels.inventory.fields.find(
  (field) => field.key === "ownershipMode",
);
const ownerField = entityFieldModels.inventory.fields.find(
  (field) => field.key === "ownerLedgerPartyId",
);
const ownerScope = referenceScopeFor(ownerField?.reference, {});
const modeOptions = modeField?.control?.options ?? [];

function OwnershipControl({ record }: { record: DetailRecordOf<"inventory"> }) {
  const ownership = record.effectiveOwnership;
  const [mode, setMode] = useState(ownership.mode);
  const [owner, setOwner] = useState<{
    id: LedgerPartyShortcode;
    name: string;
  } | null>(ownership.explicitOwner);
  const [quantity, setQuantity] = useState("");
  const save = useActionMutation({
    mutationFn: inventory.setOwnership.mutationOptions,
    success: "Ownership saved",
  });
  const confirm = useActionMutation({
    mutationFn: inventory.confirmOwnership.mutationOptions,
    success: "Owner confirmed",
  });
  const id = inventoryShortcode.parse(record.id);
  const partial = quantity.trim() ? Number(quantity) : undefined;
  return (
    <Stack gap="sm">
      <span>
        {ownership.effectiveOwner?.name ??
          (ownership.mode === "unassigned"
            ? "No individual owner"
            : "Unresolved")}
      </span>
      <span className="text-xs text-muted-foreground">
        {ownership.matchesInheritedOwner
          ? "Confirmed · matches inherited owner"
          : ownership.mode === "person"
            ? "Confirmed owner"
            : ownership.basis}
      </span>
      <OverrideControl
        label="Ownership"
        options={modeOptions}
        value={mode}
        onChange={(value) => setMode(inventoryOwnershipMode.parse(value))}
        disabled={save.isPending}
      >
        {mode === "person" ? (
          <EntityReferencePicker
            entity="ledgerParty"
            scope={ownerScope}
            label="Individual owner"
            value={owner}
            setValue={(item) =>
              setOwner(
                item
                  ? {
                      name: item.name,
                      id: ledgerPartyShortcode.parse(item.id),
                    }
                  : null,
              )
            }
          />
        ) : null}
      </OverrideControl>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Quantity to assign; leave blank for entire entry"
          type="number"
          min="0"
          step="any"
          placeholder="Entire quantity"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          className="max-w-40"
        />
        <Button
          size="sm"
          disabled={
            save.isPending ||
            (mode === "person" && !owner) ||
            (partial !== undefined &&
              (!Number.isFinite(partial) || partial <= 0))
          }
          onClick={() => {
            if (mode === "person" && !owner) return;
            save.mutate({
              inventoryEntryId: id,
              ownership:
                mode === "person" && owner
                  ? { mode, ownerId: owner.id }
                  : { mode: mode === "unassigned" ? "unassigned" : "inherit" },
              quantity: partial,
            });
          }}
        >
          Save ownership
        </Button>
        {ownership.mode === "inherit" && ownership.effectiveOwner ? (
          <Button
            size="sm"
            variant="outline"
            disabled={
              confirm.isPending ||
              (partial !== undefined &&
                (!Number.isFinite(partial) || partial <= 0))
            }
            onClick={() =>
              confirm.mutate({
                inventoryEntryId: id,
                evidenceFingerprint: ownership.evidenceFingerprint,
                quantity: partial,
              })
            }
          >
            Confirm {ownership.effectiveOwner.name}
          </Button>
        ) : null}
      </div>
      <InventoryExpenseActions record={record} />
    </Stack>
  );
}

export const inventoryDetailFields = {
  ownershipMode: () => ({ value: null, hide: true }),
  ownerLedgerPartyId: () => ({ value: null, hide: true }),
  effectiveOwnership: (record) => ({
    value: (
      <OwnershipControl
        key={`${record.id}:${record.effectiveOwnership.mode}:${record.effectiveOwnership.explicitOwner?.id ?? ""}`}
        record={record}
      />
    ),
  }),
} satisfies EntityDetailFieldRenderers<"inventory">;
