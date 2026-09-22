import type { MealFoodAmount } from "@cubby/schemas/meal";
import {
  hasKnownEstimate,
  type MeasureEstimate,
} from "@cubby/schemas/nutrition";
import { useEffect, useId, useMemo, useState } from "react";

import { tryFormatAmount } from "~/app/_components/inventory/format-amount";
import { Row, Stack } from "~/components/layout";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { formatEstimate } from "~/lib/nutrition-format";
import { wasm } from "~/lib/wasm";

export type FoodAmountSourceKind =
  | "product"
  | "ingredient"
  | "recipe"
  | "manual";

const BASE_UNIT_SUGGESTIONS = {
  product: ["g", "serving", "oz", "kg", "lb"],
  ingredient: ["g", "oz", "kg", "lb", "cup", "tbsp", "tsp"],
  recipe: ["g", "serving", "batch", "oz", "kg", "lb"],
  manual: ["g", "oz", "kg", "lb"],
} as const satisfies Record<FoodAmountSourceKind, readonly string[]>;
const NO_SUGGESTED_UNITS: readonly string[] = [];

const compactNumber = (value: number) =>
  Number(value.toFixed(2)).toLocaleString();

export function formatFoodAmount(amount: {
  value: number;
  unit: string;
  upperValue?: number;
}): string {
  const formatted = tryFormatAmount(amount);
  return formatted.startsWith("Error formatting amount:")
    ? `${compactNumber(amount.value)} ${amount.unit}`
    : formatted;
}

export function formatFoodAmountEstimate(
  estimate: Pick<FoodAmountEstimate, "grams" | "weight" | "batchShare">,
): string {
  const parts: string[] = [];
  if (estimate.grams != null) {
    parts.push(`Estimated weight ${compactNumber(estimate.grams)} g`);
  } else if (hasKnownEstimate(estimate.weight)) {
    parts.push(
      `Estimated weight ${formatEstimate(estimate.weight, (value) => `${compactNumber(value)} g`)}`,
    );
  }
  if (hasKnownEstimate(estimate.batchShare)) {
    parts.push(
      `${formatEstimate(estimate.batchShare, (value) => `${compactNumber(value * 100)}%`)} of batch`,
    );
  }
  if (parts.length) return parts.join(" · ");
  return "Current conversion unavailable; this amount can still be saved.";
}

export type FoodAmountEstimate = {
  grams: number | null;
  weight: MeasureEstimate;
  batchShare: MeasureEstimate;
};

function FoodAmountEstimateText({
  amount,
  estimate,
}: {
  amount: MealFoodAmount | null;
  estimate: FoodAmountEstimate | null;
}) {
  if (!amount) return null;
  return (
    <Description size="xs" aria-live="polite">
      {estimate
        ? formatFoodAmountEstimate(estimate)
        : "Current conversion unavailable; this amount can still be saved."}
    </Description>
  );
}

export function FoodAmountReadout({
  amount,
  estimate,
}: {
  amount: MealFoodAmount | null;
  estimate: FoodAmountEstimate;
}) {
  return (
    <span className="grid justify-items-end gap-0.5 tabular-nums">
      <span className="text-sm text-foreground">
        {amount ? formatFoodAmount(amount) : "Amount not entered"}
      </span>
      <span className="text-xs text-muted-foreground">
        {amount
          ? formatFoodAmountEstimate(estimate)
          : "Macros entered directly"}
      </span>
    </span>
  );
}

export function FoodAmountEditor({
  amount,
  onChange,
  sourceKind,
  suggestedUnits = NO_SUGGESTED_UNITS,
  estimate = null,
  onValidityChange,
  label = "Amount",
  required = true,
  id,
}: {
  amount: MealFoodAmount | null;
  onChange: (amount: MealFoodAmount | null) => void;
  sourceKind: FoodAmountSourceKind;
  suggestedUnits?: readonly string[];
  estimate?: FoodAmountEstimate | null;
  onValidityChange?: (valid: boolean) => void;
  label?: string;
  required?: boolean;
  id?: string;
}) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const [valueText, setValueText] = useState(() =>
    amount ? wasm.format_quantity(amount.value) : "",
  );
  const [unit, setUnit] = useState(amount?.unit ?? "g");
  const [focused, setFocused] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const units = useMemo(
    () =>
      [...new Set([...suggestedUnits, ...BASE_UNIT_SUGGESTIONS[sourceKind]])]
        .map((value) => value.trim())
        .filter(Boolean),
    [sourceKind, suggestedUnits],
  );

  useEffect(() => {
    if (focused || invalid) return;
    setValueText(amount ? wasm.format_quantity(amount.value) : "");
    if (amount) setUnit(amount.unit);
  }, [amount, focused, invalid]);

  const parse = (nextValue: string, nextUnit: string) => {
    const trimmedValue = nextValue.trim();
    const trimmedUnit = nextUnit.trim();
    if (!trimmedValue) {
      setInvalid(false);
      onValidityChange?.(!required);
      onChange(null);
      return;
    }
    try {
      const value = wasm.parse_quantity(trimmedValue);
      if (!Number.isFinite(value) || !(value > 0) || !trimmedUnit)
        throw new Error("invalid amount");
      setInvalid(false);
      onValidityChange?.(true);
      onChange({ value, unit: trimmedUnit });
    } catch {
      // SILENT: user is still typing an amount; invalid input is expected
      // mid-edit and is surfaced via the field's own invalid state, not a toast.
      setInvalid(true);
      onValidityChange?.(false);
      onChange(null);
    }
  };

  const commit = () => {
    parse(valueText, unit);
    if (!invalid && valueText.trim()) {
      try {
        setValueText(wasm.format_quantity(wasm.parse_quantity(valueText)));
      }
      // SILENT: reformatting is cosmetic; keep the person's text in place
      // so they can repair it (the invalid state above already flagged it).
      catch {}
    }
  };

  return (
    <Stack gap="xs">
      <Label htmlFor={`${fieldId}-value`}>
        {label}
        {!required ? " (optional)" : ""}
      </Label>
      <Row gap="sm" align="start">
        <Input
          id={`${fieldId}-value`}
          type="text"
          inputMode="text"
          className="h-11 min-w-0 flex-[2] text-right font-mono tabular-nums"
          value={valueText}
          required={required}
          aria-invalid={invalid || undefined}
          placeholder="1"
          onFocus={() => setFocused(true)}
          onChange={(event) => {
            const next = event.target.value;
            setValueText(next);
            parse(next, unit);
          }}
          onBlur={() => {
            setFocused(false);
            commit();
          }}
        />
        <div className="min-w-0 flex-1">
          <Label htmlFor={`${fieldId}-unit`} className="sr-only">
            Unit
          </Label>
          <Input
            id={`${fieldId}-unit`}
            list={`${fieldId}-units`}
            className="h-11 font-mono"
            value={unit}
            required={required || amount != null}
            aria-invalid={(amount != null && !unit.trim()) || undefined}
            placeholder="unit"
            onChange={(event) => {
              const next = event.target.value;
              setUnit(next);
              parse(valueText, next);
            }}
            onBlur={() => parse(valueText, unit)}
          />
          <datalist id={`${fieldId}-units`}>
            {units.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </datalist>
        </div>
      </Row>
      <Description size="xs">
        Suggested: {units.join(", ")}. Other units are kept as entered.
      </Description>
      <FoodAmountEstimateText amount={amount} estimate={estimate} />
    </Stack>
  );
}
