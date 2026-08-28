import type { ReactNode } from "react";
import type {
  FieldPathByValue,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";

import { UnifiedTextField } from "../form-utils";
import { AmountFieldGroup } from "../inventory/amount-field-group";

interface UnitMappingPairFieldProps<
  TFieldValues extends FieldValues,
  TValueAPath extends FieldPathByValue<TFieldValues, number | null | undefined>,
  TUnitAPath extends FieldPathByValue<TFieldValues, string | null | undefined>,
  TValueBPath extends FieldPathByValue<TFieldValues, number | null | undefined>,
  TUnitBPath extends FieldPathByValue<TFieldValues, string | null | undefined>,
  TSourcePath extends FieldPathByValue<TFieldValues, string | null | undefined>,
> {
  form: UseFormReturn<TFieldValues>;
  valueAPath: TValueAPath;
  unitAPath: TUnitAPath;
  valueBPath: TValueBPath;
  unitBPath: TUnitBPath;
  sourcePath: TSourcePath;
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
  TFieldValues extends FieldValues,
  TValueAPath extends FieldPathByValue<TFieldValues, number | null | undefined>,
  TUnitAPath extends FieldPathByValue<TFieldValues, string | null | undefined>,
  TValueBPath extends FieldPathByValue<TFieldValues, number | null | undefined>,
  TUnitBPath extends FieldPathByValue<TFieldValues, string | null | undefined>,
  TSourcePath extends FieldPathByValue<TFieldValues, string | null | undefined>,
>({
  form,
  valueAPath,
  unitAPath,
  valueBPath,
  unitBPath,
  sourcePath,
  showSource = false,
}: UnitMappingPairFieldProps<
  TFieldValues,
  TValueAPath,
  TUnitAPath,
  TValueBPath,
  TUnitBPath,
  TSourcePath
>): ReactNode {
  return (
    <>
      <div className="min-w-[11rem] flex-1">
        <AmountFieldGroup
          compact
          form={form}
          valuePath={valueAPath}
          unitPath={unitAPath}
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
          valuePath={valueBPath}
          unitPath={unitBPath}
        />
      </div>
      {showSource && (
        <div className="min-w-[8rem] flex-1">
          <UnifiedTextField
            form={form}
            name={sourcePath}
            label="Source"
            placeholder="Optional"
            nullable={true}
          />
        </div>
      )}
    </>
  );
}
