import { UNRESOLVABLE_ENTITY_FILTER } from "@cubby/shared";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";

import { Badge } from "~/components/ui/badge";

interface ScopeChipProps {
  name: string;
  value: string;
  onClear: () => void;
}

export function ScopeChip({ name, value, onClear }: ScopeChipProps) {
  const displayValue =
    value === UNRESOLVABLE_ENTITY_FILTER ? "Invalid link filter" : value;
  return (
    <Badge variant="outline" className="gap-1 pr-1">
      <span className="text-muted-foreground">{name}:</span>
      <span className="font-sans tracking-normal normal-case">
        {displayValue}
      </span>
      <button
        type="button"
        aria-label={`Clear ${name} scope`}
        onClick={onClear}
        className="text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </Badge>
  );
}
