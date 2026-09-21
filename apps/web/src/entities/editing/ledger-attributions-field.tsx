import { ledgerAttributions } from "@cubby/schemas/ledger-party";
import {
  Controller,
  type FieldValues,
  type UseFormReturn,
} from "react-hook-form";

import { EntityPicker } from "~/app/_components/combobox/entity-picker";
import { WithEntitySearch } from "~/app/_components/combobox/with-search-hook";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

/** Weights are relative shares; an explicit null party preserves an unattributed share. */
export function LedgerAttributionsField({
  form,
  name,
  label,
}: {
  form: UseFormReturn<FieldValues>;
  name: string;
  label: string;
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => {
        const rows = ledgerAttributions.parse(field.value ?? []);
        return (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{label}</legend>
            {rows.map((row, index) => (
              <div
                key={row.partyId ?? "unattributed"}
                className="flex items-center gap-2"
              >
                <WithEntitySearch entity="ledgerParty">
                  {(props) => (
                    <EntityPicker
                      {...props}
                      entity="ledgerParty"
                      label={`${label} party`}
                      placeholder="Unattributed share"
                      value={
                        row.partyId
                          ? (props.items.find(
                              (item) => item.id === row.partyId,
                            ) ?? { id: row.partyId, name: row.partyId })
                          : null
                      }
                      setValue={(item) => {
                        if (
                          rows.some(
                            (other, at) =>
                              at !== index &&
                              other.partyId === (item?.id ?? null),
                          )
                        )
                          return;
                        field.onChange(
                          rows.map((other, at) =>
                            at === index
                              ? { ...other, partyId: item?.id ?? null }
                              : other,
                          ),
                        );
                      }}
                    />
                  )}
                </WithEntitySearch>
                <Input
                  className="w-20"
                  type="number"
                  min="1"
                  step="1"
                  aria-label={`${label} relative weight`}
                  value={row.weight}
                  onChange={(event) => {
                    const weight = Number(event.target.value);
                    if (Number.isSafeInteger(weight) && weight > 0)
                      field.onChange(
                        rows.map((other, at) =>
                          at === index ? { ...other, weight } : other,
                        ),
                      );
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    field.onChange(rows.filter((_, at) => at !== index))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={rows.some((row) => row.partyId === null)}
              onClick={() =>
                field.onChange([...rows, { partyId: null, weight: 1 }])
              }
            >
              Add share
            </Button>
            <p className="text-xs text-muted-foreground">
              Weights specify relative shares. Beneficiaries and funders are
              independent.
            </p>
            {fieldState.error?.message ? (
              <p role="alert">{fieldState.error.message}</p>
            ) : null}
          </fieldset>
        );
      }}
    />
  );
}
