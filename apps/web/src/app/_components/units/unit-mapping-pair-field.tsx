import type { ReactNode } from "react";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { UnifiedTextField } from "../form-utils";
import { AmountFieldGroup } from "../inventory/amount-field-group";

interface UnitMappingPairFieldProps<
  TFieldValues extends FieldValues = FieldValues,
> {
  form: UseFormReturn<TFieldValues>;
  /**
   * Base path to the mapping object, e.g. `unitMappings.${index}`. The two sides
   * are read from `${path}.a.{value,unit}` and `${path}.b.{value,unit}`; the
   * optional source from `${path}.source`.
   */
  path: string;
  /** Render the optional free-text "source" field after the pair. */
  showSource?: boolean;
}

/**
 * Composable "unit A · amount A = unit B · amount B" editor — two
 * {@link AmountFieldGroup}s joined by an `=`, plus an optional source field. Owns
 * the row layout so any unit-mapping form (product conversions, future callers)
 * gets the same shape. The DB-edge shape stays `manualUnitMapping(a, b, source?)`
 * from `@cubby/schemas/unitmapping`; this is purely presentation.
 */
export function UnitMappingPairField<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  path,
  showSource = false,
}: UnitMappingPairFieldProps<TFieldValues>): ReactNode {
  return (
    <>
      <div className="min-w-[11rem] flex-1">
        <AmountFieldGroup
          compact
          form={form}
          valuePath={`${path}.a.value` as Path<TFieldValues>}
          unitPath={`${path}.a.unit` as Path<TFieldValues>}
        />
      </div>
      <span
        className={
          "pb-1.5 text-muted-foreground" /* tight: baseline-aligns = with compact inputs */
        }
      >
        =
      </span>
      <div className="min-w-[11rem] flex-1">
        <AmountFieldGroup
          compact
          form={form}
          valuePath={`${path}.b.value` as Path<TFieldValues>}
          unitPath={`${path}.b.unit` as Path<TFieldValues>}
        />
      </div>
      {showSource && (
        <div className="min-w-[8rem] flex-1">
          <UnifiedTextField
            form={form}
            name={`${path}.source` as Path<TFieldValues>}
            label="Source"
            placeholder="Optional"
            nullable={true}
          />
        </div>
      )}
    </>
  );
}
