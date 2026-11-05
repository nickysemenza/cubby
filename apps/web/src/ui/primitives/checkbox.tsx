import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { cn } from "cn"
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check"
import { MinusIcon } from "@phosphor-icons/react/dist/csr/Minus"
import { useHydrationGate } from "~/ui/hooks/use-hydrated"

function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  const gate = useHydrationGate(props.disabled)
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer relative flex size-4 shrink-0 items-center justify-center rounded-[3px] border border-checkbox-border bg-card transition-colors duration-150 outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-input after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 aria-invalid:aria-checked:border-primary data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground group-has-[:focus-visible]/field-label:data-checked:border-primary",
        gate["data-hydrating"] !== undefined && "disabled:opacity-100",
        className
      )}
      {...props}
      {...gate}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <MinusIcon className="hidden [[data-indeterminate]>&]:block" />
        <CheckIcon className="block [[data-indeterminate]>&]:hidden" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
