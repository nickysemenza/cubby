import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Currency formatting is shared across web + mobile to prevent drift.
export { formatCurrency } from "@cubby/shared";
