import { Check, Minus } from "lucide-react";
import { Checkbox } from "react-aria-components";

export default function SelectionCheckbox() {
  return (
    <Checkbox
      slot="selection"
      className="block h-4 w-4 shrink-0 rounded-sm border border-black ring-offset-1 data-disabled:cursor-not-allowed data-disabled:opacity-50 data-focus-visible:ring-2 data-focus-visible:ring-black data-focus-visible:ring-offset-2 data-focus-visible:outline-hidden data-indeterminate:bg-black data-indeterminate:text-white data-selected:bg-black data-selected:text-white"
    >
      {({ isSelected, isIndeterminate }) => (
        <div className="flex items-center justify-center text-current">
          {isSelected ? (
            <Check className="h-4 w-4" aria-hidden="true" />
          ) : isIndeterminate ? (
            <Minus className="h-4 w-4" aria-hidden="true" />
          ) : null}
        </div>
      )}
    </Checkbox>
  );
}
