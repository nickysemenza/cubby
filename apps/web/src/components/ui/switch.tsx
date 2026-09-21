import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { useHydrationGate } from "~/hooks/useHydrated";
import { cn } from "~/lib/utils";

interface SwitchProps extends SwitchPrimitive.Root.Props {
  className?: string;
}

function Switch({ className, ...props }: SwitchProps) {
  const gate = useHydrationGate(props.disabled);
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-none border-2 border-transparent transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "bg-input data-checked:bg-primary",
        gate["data-hydrating"] !== undefined && "disabled:opacity-100",
        className,
      )}
      {...props}
      {...gate}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-none bg-background ring-0 transition-transform",
          "translate-x-0 data-checked:translate-x-4",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
