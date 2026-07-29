import { X } from "lucide-react";
import { Badge } from "~/components/ui/badge";

interface ScopeChipProps {
  name: string;
  value: string;
  onClear: () => void;
}

export function ScopeChip({ name, value, onClear }: ScopeChipProps) {
  return (
    <Badge variant="outline" className="gap-1 pr-1">
      <span className="text-muted-foreground">{name}:</span>
      <span className="font-sans normal-case tracking-normal">{value}</span>
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
