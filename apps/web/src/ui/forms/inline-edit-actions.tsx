import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

import { Button } from "~/ui/primitives/button";

export function InlineEditActions({
  onSave,
  onCancel,
  disabled,
}: {
  onSave: () => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={onSave}
        disabled={disabled}
        aria-label="Save value"
      >
        <CheckIcon aria-hidden />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        onClick={onCancel}
        disabled={disabled}
        aria-label="Cancel editing"
      >
        <XIcon aria-hidden />
      </Button>
    </>
  );
}
