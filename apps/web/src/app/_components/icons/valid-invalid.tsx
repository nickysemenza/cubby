import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon as X } from "@phosphor-icons/react/dist/csr/X";

export default function ValidInvalidIcon({ isValid }: { isValid: boolean }) {
  return isValid ? (
    <Check className="size-4 text-accent-foreground" />
  ) : (
    <X className="size-4 text-destructive" />
  );
}
