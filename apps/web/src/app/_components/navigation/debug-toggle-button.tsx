import { Bug, BugOff } from "lucide-react";

import { Button } from "~/components/ui/button";
import { useDebug } from "~/hooks/useDebug";
import { cn } from "~/lib/utils";

export function DebugToggleButton({
  className,
  onAfterToggle,
  compact = true,
}: {
  className?: string;
  onAfterToggle?: () => void;
  compact?: boolean;
}) {
  const { isDebugEnabled, toggleDebug } = useDebug();
  const label = isDebugEnabled ? "Disable Debug" : "Enable Debug";
  const Icon = isDebugEnabled ? BugOff : Bug;
  const title = compact
    ? `${isDebugEnabled ? "Disable" : "Enable"} debug mode`
    : undefined;

  return (
    <Button
      variant="ghost"
      size={compact ? "sm" : "default"}
      onClick={() => {
        toggleDebug();
        onAfterToggle?.();
      }}
      className={cn(
        compact ? "h-8 px-2" : "min-h-[44px] justify-start px-2 py-2 text-sm",
        isDebugEnabled && "bg-warning/30 text-accent-foreground",
        className,
      )}
      title={title}
    >
      <Icon className={compact ? "size-3.5" : "mr-2 size-3.5"} />
      {compact ? <span className="sr-only">Toggle debug mode</span> : label}
    </Button>
  );
}
