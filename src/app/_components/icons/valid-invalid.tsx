import { Check, X } from "lucide-react";

export function ValidInvalidIcon({ isValid }: { isValid: boolean }) {
  return isValid ? (
    <Check className="h-4 w-4 text-green-700" />
  ) : (
    <X className="h-4 w-4 text-red-700" />
  );
}
export default ValidInvalidIcon;
