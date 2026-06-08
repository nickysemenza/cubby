import type { AppRouter } from "@cubby/api-contract";
import type { inferRouterOutputs } from "@cubby/api-contract";
import { createTRPCContext } from "@trpc/tanstack-react-query";

// Mirrors apps/web/src/integrations/trpc/react.ts — the AppRouter type is sourced
// from @cubby/api-contract (type-only firewall; no server runtime reaches Metro).
export const { TRPCProvider, useTRPC, useTRPCClient } =
  createTRPCContext<AppRouter>();

export type RouterOutputs = inferRouterOutputs<AppRouter>;
