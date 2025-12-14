"use client";

import * as React from "react";
import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { AmountKind, WAmount } from "@recipehub/recipebridge";
import { amount, Amount } from "~/codec/codec";
import { UnitMapping } from "~/schemas/unitmapping";
import { wasm } from "~/lib/wasm";
import { safeConvertAmount } from "./univ-conversion";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";
import { Scale } from "lucide-react";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { kindIconMap } from "./kind-icons";
import { Result } from "~/misc/result-types";
import { FormWrapper } from "~/app/_components/form-utils";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { ConversionCapabilities } from "./ConversionCapabilities";
import { UnitMappingGraph } from "./UnitMappingGraph";
import { UnitMappingsTable } from "./unitmappingstable";

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

export function ConversionDialog({ mappings }: ConversionDialogProps) {
  const [open, setOpen] = useState(false);
  const [showNutrients, setShowNutrients] = useState(false);
  const [conversions, setConversions] = useState<
    Record<AmountKind, Result<WAmount>>
  >({} as Record<AmountKind, Result<WAmount>>);

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
    // eslint-disable-next-line react-hooks/incompatible-library -- React Hook Form API limitation
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

  // Trigger initial conversion when dialog opens
  React.useEffect(() => {
    if (open) {
      const values = form.getValues();
      if (values.amount?.value && values.amount?.unit) {
        performConversions(values.amount);
      }
    }
  }, [form, open, performConversions]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>
            <Button
              variant="secondary"
              pop
              size="sm"
              className="flex items-center gap-1"
            >
              <Scale className="h-4 w-4" />
              <span>Convert</span>
            </Button>
          </DialogTrigger>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>Open unit converter</TooltipContent>
      </Tooltip>
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
                id="show-nutrients"
                checked={showNutrients}
                onCheckedChange={(checked) =>
                  setShowNutrients(checked === true)
                }
              />
              <Label htmlFor="show-nutrients" className="text-sm">
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
              <h4 className="text-sm font-medium">Conversion Graph</h4>
              <UnitMappingGraph unitMapping={filteredMappings} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Available Unit Mappings</h4>
              <div className="max-h-60 overflow-y-auto rounded-md border">
                <UnitMappingsTable mappings={filteredMappings} />
              </div>
            </div>
            <div>
              <FormWrapper
                form={form}
                onSubmit={() => {
                  setOpen(false);
                }}
                isPending={false}
                submitButtonText="Apply"
                onCancel={() => setOpen(false)}
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
                  <h4 className="text-sm font-medium">Conversion Results</h4>
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
    </Dialog>
  );
}
