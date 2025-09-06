import { Check, X } from "lucide-react";

export default function ValidInvalidIcon({ isValid }: { isValid: boolean }) {
  return isValid ? (
    <Check className="text-accent-foreground h-4 w-4" />
  ) : (
    <X className="text-destructive h-4 w-4" />
  );
}
