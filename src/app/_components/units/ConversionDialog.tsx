"use client";

import * as React from "react";
import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { MeasureKind, WMeasure } from "recipebridge/pkg/recipebridge";
import { amount, Amount } from "~/codec/codec";
import { UnitMapping } from "~/schemas/unitmapping";
import { useWasm } from "~/hooks/useWasm";
import { safeConvertAmount } from "~/app/_components/units/univ-conversion";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Scale } from "lucide-react";
import { Result } from "~/misc/result-types";
import { FormWrapper } from "~/app/_components/form-utils";
import { AmountFieldGroup } from "~/app/_components/inventory/amount-field-group";
import { ConversionCapabilities } from "./ConversionCapabilities";
import { UnitMappingGraph } from "./UnitMappingGraph";

const formSchema = z.object({
  amount: amount,
});

type FormValues = z.infer<typeof formSchema>;

interface ConversionDialogProps {
  mappings: UnitMapping[];
}

const measureKinds: MeasureKind[] = [
  "weight",
  "volume",
  "money",
  "calories",
  "time",
  "temperature",
  "length",
  "other",
];

export function ConversionDialog({ mappings }: ConversionDialogProps) {
  const w = useWasm();
  const [open, setOpen] = useState(false);
  const [conversions, setConversions] = useState<
    Record<MeasureKind, Result<WMeasure>>
  >({} as Record<MeasureKind, Result<WMeasure>>);

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
      const results: Record<MeasureKind, Result<WMeasure>> = {} as Record<
        MeasureKind,
        Result<WMeasure>
      >;

      for (const kind of measureKinds) {
        results[kind] = safeConvertAmount(w, currentAmount, mappings, kind);
      }

      setConversions(results);
    },
    [w, mappings],
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
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="flex items-center gap-1">
          <Scale className="h-4 w-4" />
          <span>Convert</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[700px]">
        <DialogHeader>
          <DialogTitle>Unit Conversion</DialogTitle>
          <DialogDescription>
            Enter an amount to see live conversions to different unit types.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <ConversionCapabilities mappings={mappings} />
            
            <div className="space-y-2">
              <h4 className="text-sm font-medium">Conversion Graph</h4>
              <UnitMappingGraph unitMapping={mappings} />
            </div>
          </div>

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
                {measureKinds.map((kind) => {
                  const result = conversions[kind];
                  return (
                    <div
                      key={kind}
                      className="flex items-center justify-between border-b py-1"
                    >
                      <span className="font-medium capitalize">{kind}:</span>
                      <span>
                        {result?.success
                          ? w.format_amount(result.value)
                          : "Not convertible"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
