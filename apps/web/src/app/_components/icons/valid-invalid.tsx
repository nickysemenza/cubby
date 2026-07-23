import { Check, X } from "lucide-react";

export default function ValidInvalidIcon({ isValid }: { isValid: boolean }) {
  return isValid ? (
    <Check className="size-4 text-accent-foreground" />
  ) : (
    <X className="size-4 text-destructive" />
  );
}
