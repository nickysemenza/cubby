import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/dist/csr/CaretUp";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
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
      <CaretUpIcon className="size-4" />
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => move(index, Math.min(fieldsLength - 1, index + 1))}
      disabled={index === fieldsLength - 1}
    >
      <CaretDownIcon className="size-4" />
    </Button>
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => remove(index)}
    >
      <TrashIcon className="size-4" />
    </Button>
  </div>
);
