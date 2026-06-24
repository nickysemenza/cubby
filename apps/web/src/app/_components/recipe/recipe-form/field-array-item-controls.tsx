import { ChevronDown, ChevronUp, Trash } from "lucide-react";
import type { FC } from "react";
import { Button } from "~/components/ui/button";

interface FieldArrayItemControlsProps {
  move: (from: number, to: number) => void;
  remove: (index: number) => void;
  index: number;
  fieldsLength: number;
  className?: string;
}

export const FieldArrayItemControls: FC<FieldArrayItemControlsProps> = ({
  move,
  remove,
  index,
  fieldsLength,
  className = "mt-6 flex flex-col space-y-1",
}) => (
  <div className={className}>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => move(index, Math.max(0, index - 1))}
      disabled={index === 0}
    >
      <ChevronUp className="h-4 w-4" />
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => move(index, Math.min(fieldsLength - 1, index + 1))}
      disabled={index === fieldsLength - 1}
    >
      <ChevronDown className="h-4 w-4" />
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => remove(index)}
    >
      <Trash className="h-4 w-4" />
    </Button>
  </div>
);
