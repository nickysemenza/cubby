import type { ReactNode } from "react";

// HydrateClient is not needed in TanStack Start - just pass through children
export const HydrateClient = ({ children }: { children: ReactNode }) =>
  children;
