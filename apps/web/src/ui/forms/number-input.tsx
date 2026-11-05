import { NumberField } from "@base-ui/react/number-field";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { cn } from "cn";
import type * as React from "react";

import { useHydrationGate } from "~/ui/hooks/use-hydrated";

type Props = Omit<
  React.ComponentProps<typeof NumberField.Input>,
  "value" | "onChange" | "size" | "min" | "max" | "step"
> & {
  value: number | null;
  onValueChange: (value: number | null) => void;
  onValueCommitted?: (value: number | null) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  size?: "default" | "sm";
  stepButtons?: boolean;
};

export function NumberInput({
  value,
  onValueChange,
  onValueCommitted,
  min,
  max,
  step,
  size = "default",
  stepButtons = false,
  className,
  disabled,
  required,
  name,
  id,
  inputMode = "decimal",
  ...props
}: Props) {
  const gate = useHydrationGate(disabled);
  const buttonClass =
    "flex shrink-0 items-center justify-center px-2 text-muted-foreground hover:text-foreground disabled:opacity-50";
  return (
    <NumberField.Root
      className={className}
      value={value}
      onValueChange={onValueChange}
      onValueCommitted={onValueCommitted}
      min={min}
      max={max}
      step={step}
      disabled={gate.disabled}
      required={required}
      name={name}
      id={id}
    >
      {/* oxlint-disable-next-line cubby/no-hand-rolled-panel -- This border belongs to the input control. */}
      <NumberField.Group
        className={cn(
          "flex h-(--input-height) w-full min-w-0 rounded-sm border border-border bg-card transition-colors duration-150 focus-within:border-ring focus-within:ring-[2px] focus-within:ring-ring/30 has-disabled:bg-muted has-disabled:opacity-60 has-aria-invalid:border-destructive has-aria-invalid:ring-destructive/20 max-sm:h-11",
          size === "sm" && "h-8",
        )}
      >
        {stepButtons && (
          <NumberField.Decrement aria-label="Decrease" className={buttonClass}>
            <MinusIcon className="size-4" />
          </NumberField.Decrement>
        )}
        <NumberField.Input
          {...props}
          {...gate}
          inputMode={inputMode}
          className={cn(
            "w-full min-w-0 bg-transparent px-2.5 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed max-sm:text-base",
            className,
          )}
        />
        {stepButtons && (
          <NumberField.Increment aria-label="Increase" className={buttonClass}>
            <PlusIcon className="size-4" />
          </NumberField.Increment>
        )}
      </NumberField.Group>
    </NumberField.Root>
  );
}
