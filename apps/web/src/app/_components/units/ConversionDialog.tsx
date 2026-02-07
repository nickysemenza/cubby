import type { AmountKind, WAmount } from "@cubby/recipebridge";
import { type Amount, amount } from "@cubby/schemas/codec";
import type { UnitMapping } from "@cubby/schemas/unitmapping";
import { zodResolver } from "@hookform/resolvers/zod";
import { Scale } from "lucide-react";
import * as React from "react";
import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormWrapper } from "~/app/_components/form-utils";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
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
import { wasm } from "~/lib/wasm";
import type { Result } from "~/misc/result-types";
import { ConversionCapabilities } from "./ConversionCapabilities";
import { kindIconMap } from "./kind-icons";
import { UnitMappingGraph } from "./UnitMappingGraph";
import { UnitMappingsTable } from "./unitmappingstable";
import { safeConvertAmount } from "./univ-conversion";

const formSchema = z.object({
  amount: amount,
});

type FormValues = z.infer<typeof formSchema>;

interface ConversionDialogProps {
  mappings: UnitMapping[];
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

function ConversionDialogContent({
  mappings,
  onClose,
}: {
  mappings: UnitMapping[];
  onClose: () => void;
}) {
  const showNutrientsId = useId();
  const [showNutrients, setShowNutrients] = useState(false);
  const [conversions, setConversions] = useState<
    Partial<Record<AmountKind, Result<WAmount>>>
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
      const results: Record<AmountKind, Result<WAmount>> = {} as Record<
        AmountKind,
        Result<WAmount>
      >;

      for (const kind of amountKinds) {
        results[kind] = safeConvertAmount(currentAmount, mappings, kind);
      }

      setConversions(results);
    },
    [mappings],
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
    <DialogContent className="sm:max-w-[900px]">
      <DialogHeader>
        <DialogTitle>Unit Conversion</DialogTitle>
        <DialogDescription>
          Enter an amount to see live conversions to different unit types.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-4">
        {nutrientCount > 0 && (
          <div className="flex items-center gap-2">
            <Checkbox
              id={showNutrientsId}
              checked={showNutrients}
              onCheckedChange={(checked) => setShowNutrients(checked === true)}
            />
            <Label htmlFor={showNutrientsId} className="text-sm">
              Show nutrient mappings ({nutrientCount})
            </Label>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <ConversionCapabilities
            mappings={filteredMappings}
            hideConvertButton={true}
          />

          <div className="space-y-2">
            <h4 className="font-medium text-sm">Conversion Graph</h4>
            <UnitMappingGraph unitMapping={filteredMappings} />
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <h4 className="font-medium text-sm">Available Unit Mappings</h4>
            <UnitMappingsTable mappings={filteredMappings} />
          </div>
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
              <div className="mt-6 space-y-4">
                <h4 className="font-medium text-sm">Conversion Results</h4>
                <div className="space-y-2">
                  {amountKinds.map((kind) => {
                    const result = conversions[kind];
                    const Meta = kindIconMap[kind];
                    return (
                      <div
                        key={kind}
                        className="flex items-center justify-between border-b py-1"
                      >
                        <span className="flex items-center gap-2">
                          <Meta.Icon className="h-4 w-4" aria-hidden />
                          <span className="font-medium">{Meta.label}</span>
                        </span>
                        <span>
                          {result?.success
                            ? wasm.format_amount(result.value)
                            : "Not convertible"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </DialogContent>
  );
}

export function ConversionDialog({ mappings }: ConversionDialogProps) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <DialogTrigger
          render={
            <TooltipTrigger
              render={
                <Button
                  variant="secondary"
                  size="xs"
                  className="flex items-center gap-1"
                />
              }
            />
          }
        >
          <Scale className="h-3 w-3" />
          <span>Convert</span>
        </DialogTrigger>
        <TooltipContent sideOffset={6}>Open unit converter</TooltipContent>
      </Tooltip>
      {open && (
        <ConversionDialogContent
          mappings={mappings}
          onClose={() => setOpen(false)}
        />
      )}
    </Dialog>
  );
}
