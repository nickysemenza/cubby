
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";

import { useHydrationGate } from "~/hooks/useHydrated";
import { cn } from "~/lib/utils";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus";

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  const gate = useHydrationGate(props.disabled);
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "border-checkbox-border data-checked:bg-primary data-checked:text-primary-foreground data-checked:border-primary aria-invalid:aria-checked:border-primary aria-invalid:border-destructive focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 peer relative flex size-4 shrink-0 items-center justify-center rounded-sm border bg-card transition-colors duration-150 outline-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-[2px] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-[2px]",
        gate["data-hydrating"] !== undefined && "disabled:opacity-100",
        className,
      )}
      {...props}
      {...gate}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        {/* Show MinusIcon when indeterminate, CheckIcon when checked */}
        <MinusIcon className="hidden [[data-indeterminate]>&]:block" />
        <CheckIcon className="block [[data-indeterminate]>&]:hidden" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
