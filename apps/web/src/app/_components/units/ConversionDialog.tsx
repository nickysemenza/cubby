import type { AmountKind, WAmount, WConversionStep } from "@cubby/recipebridge";
import { type Amount, amount } from "@cubby/schemas/codec";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { zodResolver } from "@hookform/resolvers/zod";
import { CalculatorIcon } from "@phosphor-icons/react/dist/csr/Calculator";
import * as React from "react";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormWrapper } from "~/app/_components/form-utils";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import type { BaseKind } from "~/lib/conversion-coverage";
import { safeConvertAmount } from "~/lib/recipe-costing";
import { wasm } from "~/lib/wasm";
import type { Result } from "~/misc/result-types";

import { ConversionCapabilitiesSummary } from "./conversion-capabilities-summary";
import { kindIconFor } from "./kind-icons";
import { UnitMappingGraph } from "./unit-mapping-graph";
import { UnitMappingsTable } from "./unitmappingstable";

const formSchema = z.object({
  amount: amount,
});

type FormValues = z.infer<typeof formSchema>;

interface ConversionDialogProps {
  mappings: UnitMapping[];
  /** Icon-only, no label — for dense table cells where the coverage icons lead. */
  compact?: boolean;
  /** Restrict the kinds shown (USDA passes USDA_KINDS to drop money). */
  kinds?: readonly BaseKind[];
}

const amountKinds: AmountKind[] = [
  "weight",
  "volume",
  "money",
  "calories",
  "time",
  "temperature",
  "length",
  "other",
];

const isNutrientMapping = (m: UnitMapping) => m.source === "USDA nutrition";

/**
 * Render an explained conversion path compactly, e.g. `g ×0.0226→ scoop ×19.995→ cent`.
 * Units are the normalized graph nodes (cup enters at tsp, money at cent) —
 * showing the real traversal is the point.
 */
const formatConversionPath = (path: readonly WConversionStep[]): string => {
  const fmtFactor = (f: number) =>
    Number.parseFloat(f.toPrecision(4)).toString();
  const first = path[0];
  if (!first) return "";
  return [
    first.from_unit,
    ...path.map((s) => `×${fmtFactor(s.factor)}→ ${s.to_unit}`),
  ].join(" ");
};

function ConversionDialogContent({
  mappings,
  onClose,
  kinds,
}: {
  mappings: UnitMapping[];
  onClose: () => void;
  kinds?: readonly BaseKind[];
}) {
  // BaseKind ⊆ AmountKind, so a restricted set just narrows the rows shown.
  const effectiveKinds: readonly AmountKind[] = kinds ?? amountKinds;
  const showNutrientsId = useId();
  const [showNutrients, setShowNutrients] = useState(false);
  const [conversions, setConversions] = useState<
    Partial<Record<AmountKind, Result<WAmount>>>
  >({});
  const [paths, setPaths] = useState<
    Partial<Record<AmountKind, readonly WConversionStep[]>>
  >({});

  const filteredMappings = showNutrients
    ? mappings
    : mappings.filter((m) => !isNutrientMapping(m));
  const nutrientCount = mappings.filter(isNutrientMapping).length;

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      amount: {
        value: 1,
        unit: "cup",
      },
    },
  });

  // Function to perform conversions using useCallback for memoization
  const performConversions = React.useCallback(
    (currentAmount: Amount) => {
      const results: Partial<Record<AmountKind, Result<WAmount>>> = {};
      const resultPaths: Partial<
        Record<AmountKind, readonly WConversionStep[]>
      > = {};

      for (const kind of effectiveKinds) {
        results[kind] = safeConvertAmount(currentAmount, mappings, kind);
        // The traversed unit-graph path ("show your work") for convertible
        // kinds — surfaces e.g. a price reached via a bogus whole-count edge.
        try {
          const explained = wasm.conv_amount_explain(
            mappings,
            kind,
            currentAmount,
          );
          if (explained.path && explained.path.length > 0) {
            resultPaths[kind] = explained.path;
          }
        } catch {
          // SILENT: explain is best-effort; the result row already shows convertibility
        }
      }

      setConversions(results);
      setPaths(resultPaths);
    },
    [mappings, effectiveKinds],
  );

  // Update conversions whenever form values change
  React.useEffect(() => {
    const subscription = form.watch((values) => {
      // Only update if we have both a value and a unit
      if (values.amount?.value && values.amount?.unit) {
        const currentAmount: Amount = {
          value: values.amount.value,
          unit: values.amount.unit,
        };

        performConversions(currentAmount);
      }
    });

    return () => subscription.unsubscribe();
  }, [form, performConversions]);

  React.useEffect(() => {
    const values = form.getValues();
    if (values.amount?.value && values.amount?.unit) {
      performConversions(values.amount);
    }
  }, [form, performConversions]);

  return (
    <DialogContent size="2xl">
      <DialogHeader>
        <DialogTitle>Unit Conversion</DialogTitle>
        <DialogDescription>
          Enter an amount to see live conversions to different unit types.
        </DialogDescription>
      </DialogHeader>

      <Stack gap="sm" className="py-2">
        {nutrientCount > 0 && (
          <Row align="center" gap="sm">
            <Checkbox
              id={showNutrientsId}
              checked={showNutrients}
              onCheckedChange={(checked) => setShowNutrients(checked === true)}
            />
            <Label htmlFor={showNutrientsId} className="text-sm">
              Show nutrient mappings ({nutrientCount})
            </Label>
          </Row>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ConversionCapabilitiesSummary
            mappings={filteredMappings}
            kinds={kinds}
          />

          <Stack gap="sm">
            <h4 className="text-sm font-medium">Conversion Graph</h4>
            <UnitMappingGraph
              mappings={mappings}
              includeNutrients={showNutrients}
              height={220}
            />
          </Stack>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Stack gap="sm">
            <h4 className="text-sm font-medium">Available Unit Mappings</h4>
            <UnitMappingsTable mappings={filteredMappings} />
          </Stack>
          <div>
            <FormWrapper
              form={form}
              onSubmit={() => {
                onClose();
              }}
              isPending={false}
              submitButtonText="Apply"
              onCancel={onClose}
            >
              <AmountFieldGroup
                form={form}
                valuePath="amount.value"
                unitPath="amount.unit"
                step="0.01"
              />
            </FormWrapper>

            {Object.keys(conversions).length > 0 && (
              <Stack gap="sm" className="mt-4">
                <h4 className="text-sm font-medium">Conversion Results</h4>
                <Stack gap="sm">
                  {effectiveKinds.map((kind) => {
                    const result = conversions[kind];
                    const path = paths[kind];
                    const Meta = kindIconFor(kind);
                    return (
                      <div key={kind} className="border-b py-1">
                        <Row align="center" justify="between">
                          <Row as="span" align="center" gap="sm">
                            <Meta.Icon className="size-4" aria-hidden />
                            <span className="font-medium">{Meta.label}</span>
                          </Row>
                          <span>
                            {result?.isOk()
                              ? wasm.format_amount(result.value)
                              : "Not convertible"}
                          </span>
                        </Row>
                        {result?.isOk() && path && (
                          <Description
                            as="div"
                            size="2xs"
                            className="text-right font-mono"
                          >
                            {formatConversionPath(path)}
                          </Description>
                        )}
                      </div>
                    );
                  })}
                </Stack>
              </Stack>
            )}
          </div>
        </div>
      </Stack>
    </DialogContent>
  );
}

export function ConversionDialog({
  mappings,
  compact = false,
  kinds,
}: ConversionDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <DialogTrigger
          render={
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size={compact ? "icon-sm" : "sm"}
                  // Compact mode drops the "Convert" text, leaving only the
                  // icon — the tooltip below doesn't supply an accessible
                  // name, so mirror its wording here.
                  aria-label={compact ? "Open unit converter" : undefined}
                  className="flex items-center gap-1 text-muted-foreground"
                />
              }
            />
          }
        >
          <CalculatorIcon className="size-3" />
          {!compact && <span>Convert</span>}
        </DialogTrigger>
        <TooltipContent sideOffset={6}>Open unit converter</TooltipContent>
      </Tooltip>
      {open && (
        <ConversionDialogContent
          mappings={mappings}
          onClose={() => setOpen(false)}
          kinds={kinds}
        />
      )}
    </Dialog>
  );
}
