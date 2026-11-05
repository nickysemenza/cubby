import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/dist/csr/CaretUp";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import type { FC } from "react";

import { Button } from "~/ui/primitives/button";

interface FieldArrayItemControlsProps {
  move: (from: number, to: number) => void;
  remove: (index: number) => void;
  index: number;
  fieldsLength: number;
  itemLabel?: string;
  className?: string;
}

export const FieldArrayItemControls: FC<FieldArrayItemControlsProps> = ({
  move,
  remove,
  index,
  fieldsLength,
  itemLabel = "item",
  className = "mt-6 flex flex-col space-y-1",
}) => (
  <div className={className}>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="max-sm:min-h-11 max-sm:min-w-11"
      aria-label={`Move ${itemLabel} ${index + 1} up`}
      onClick={() => move(index, Math.max(0, index - 1))}
      disabled={index === 0}
    >
      <CaretUpIcon className="size-4" />
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="max-sm:min-h-11 max-sm:min-w-11"
      aria-label={`Move ${itemLabel} ${index + 1} down`}
      onClick={() => move(index, Math.min(fieldsLength - 1, index + 1))}
      disabled={index === fieldsLength - 1}
    >
      <CaretDownIcon className="size-4" />
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="max-sm:min-h-11 max-sm:min-w-11"
      aria-label={`Remove ${itemLabel} ${index + 1}`}
      onClick={() => remove(index)}
    >
      <TrashIcon className="size-4" />
    </Button>
  </div>
);
