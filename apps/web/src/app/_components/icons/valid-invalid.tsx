import { Check, X } from "lucide-react";

export default function ValidInvalidIcon({ isValid }: { isValid: boolean }) {
  return isValid ? (
    <Check className="h-4 w-4 text-accent-foreground" />
  ) : (
    <X className="h-4 w-4 text-destructive" />
  );
}
