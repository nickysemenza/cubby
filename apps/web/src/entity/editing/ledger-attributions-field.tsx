import { ledgerAttributions } from "@cubby/schemas/ledger-party";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { isEqual } from "es-toolkit";
import { useEffect, useRef } from "react";
import {
  Controller,
  type FieldValues,
  type UseFormReturn,
  useWatch,
} from "react-hook-form";
import { z } from "zod";

import { Picker } from "~/entity/picker/picker";
import { useEntityListSource } from "~/entity/picker/with-search-hook";
import { expense } from "~/integrations/tanstack-query/generated/domains/expense.gen";
import { NumberInput } from "~/ui/forms/number-input";
import { Button } from "~/ui/primitives/button";
import { Description } from "~/ui/text/description";

type LedgerAttributionRow = ReturnType<typeof ledgerAttributions.parse>[number];

/**
 * One share's party picker + weight + remove — extracted so
 * `useEntityListSource` (a hook) is called once per row's own component
 * instance rather than inside the parent's `rows.map`.
 */
function LedgerAttributionRowFields({
  row,
  index,
  rows,
  label,
  onChangeRows,
  disabled,
}: {
  row: LedgerAttributionRow;
  index: number;
  rows: readonly LedgerAttributionRow[];
  label: string;
  onChangeRows: (rows: LedgerAttributionRow[]) => void;
  disabled?: boolean;
}) {
  const { dialog, items, onSearchChange, isLoading, onOpenChange } =
    useEntityListSource("ledgerParty");
  return (
    <div className="flex items-center gap-2">
      {dialog}
      <Picker
        entity="ledgerParty"
        label={`${label} party`}
        disabled={disabled}
        placeholder="Unattributed share"
        items={items}
        onSearchChange={onSearchChange}
        isLoading={isLoading}
        onOpenChange={onOpenChange}
        value={
          row.partyId
            ? (items.find((item) => item.id === row.partyId) ?? {
                id: row.partyId,
                name: row.partyId,
              })
            : null
        }
        setValue={(item) => {
          if (
            rows.some(
              (other, at) =>
                at !== index && other.partyId === (item?.id ?? null),
            )
          )
            return;
          onChangeRows(
            rows.map((other, at) =>
              at === index ? { ...other, partyId: item?.id ?? null } : other,
            ),
          );
        }}
      />
      <NumberInput
        className="w-20"
        min={1}
        step={1}
        aria-label={`${label} relative weight`}
        disabled={disabled}
        value={row.weight}
        onValueChange={(weight) => {
          if (weight != null && Number.isSafeInteger(weight) && weight > 0)
            onChangeRows(
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
        disabled={disabled}
        onClick={() => onChangeRows(rows.filter((_, at) => at !== index))}
      >
        Remove
      </Button>
    </div>
  );
}

/**
 * Create-mode expense prefill: fills this role from the last attributed charge
 * with the same vendor. It only writes while the field is empty or still holds
 * the value this hook last wrote, so anything the user entered is never
 * overwritten and changing the vendor re-prefills an untouched field.
 */
function useVendorAttributionPrefill(
  form: UseFormReturn<FieldValues>,
  name: string,
  enabled: boolean,
) {
  const vendor: unknown = useWatch({ control: form.control, name: "vendor" });
  // The vendor field is typed into, so wait for it to settle before querying.
  const [vendorName] = useDebouncedValue(
    z.string().catch("").parse(vendor).trim(),
    { wait: 400 },
  );
  const { data } = useQuery({
    ...expense.vendorAttributionDefaults.queryOptions({ vendor: vendorName }),
    enabled: enabled && vendorName.length > 0,
  });
  const lastWritten = useRef<unknown>(null);
  useEffect(() => {
    const suggested = name === "funders" ? data?.funders : data?.beneficiaries;
    if (!suggested?.length) return;
    const current: unknown = form.getValues(name);
    const untouched =
      !Array.isArray(current) ||
      current.length === 0 ||
      isEqual(current, lastWritten.current);
    if (!untouched) return;
    lastWritten.current = suggested;
    form.setValue(name, suggested, { shouldDirty: true });
  }, [data, form, name]);
}

/** Weights are relative shares; an explicit null party preserves an unattributed share. */
export function LedgerAttributionsField({
  form,
  name,
  label,
  prefillFromVendor = false,
}: {
  form: UseFormReturn<FieldValues>;
  name: string;
  label: string;
  /** Expense create only: default from the last set used with the form's `vendor`. */
  prefillFromVendor?: boolean;
}) {
  useVendorAttributionPrefill(form, name, prefillFromVendor);
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field, fieldState }) => {
        const rows = ledgerAttributions.parse(field.value ?? []);
        return (
          <>
            <LedgerAttributionsEditor
              rows={rows}
              label={label}
              onChangeRows={field.onChange}
              disabled={field.disabled}
            />
            {fieldState.error?.message ? (
              <p role="alert">{fieldState.error.message}</p>
            ) : null}
          </>
        );
      }}
    />
  );
}

/** The same relative-share editor serves generic forms and reviewed aggregate booking. */
function LedgerAttributionsEditor({
  rows,
  label,
  onChangeRows,
  disabled,
}: {
  rows: readonly LedgerAttributionRow[];
  label: string;
  onChangeRows: (rows: LedgerAttributionRow[]) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{label}</legend>
      {rows.map((row, index) => (
        <LedgerAttributionRowFields
          key={row.partyId ?? "unattributed"}
          row={row}
          index={index}
          rows={rows}
          label={label}
          onChangeRows={onChangeRows}
          disabled={disabled}
        />
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || rows.some((row) => row.partyId === null)}
        onClick={() => onChangeRows([...rows, { partyId: null, weight: 1 }])}
      >
        Add share
      </Button>
      <p className="text-xs text-muted-foreground">
        Weights specify relative shares. Beneficiaries and funders are
        independent.
      </p>
    </fieldset>
  );
}

/** Review drafts keep omitted defaults distinct from an explicit empty or unknown share. */
export function ReviewedBeneficiariesField({
  value,
  onChange,
  disabled,
}: {
  value: LedgerAttributionRow[] | undefined;
  onChange: (value: LedgerAttributionRow[] | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <>
      <LedgerAttributionsEditor
        label="Beneficiaries for a new Expense"
        rows={value ?? []}
        disabled={disabled}
        onChangeRows={onChange}
      />
      {value !== undefined ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => onChange(undefined)}
        >
          Use default beneficiaries
        </Button>
      ) : null}
    </>
  );
}
