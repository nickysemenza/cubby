import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";

export default function ValidInvalidIcon({ isValid }: { isValid: boolean }) {
  return isValid ? (
    <CheckIcon className="size-4 text-accent-foreground" />
  ) : (
    <XIcon className="size-4 text-destructive" />
  );
}
