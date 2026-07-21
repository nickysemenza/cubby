import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import type { TRPCRouter } from "~/integrations/trpc/router";

export const { TRPCProvider, useTRPC, useTRPCClient } =
  createTRPCContext<TRPCRouter>();

/**
 * Inference helper for outputs.
 */
export type RouterOutputs = inferRouterOutputs<TRPCRouter>;

/**
 * Inference helper for inputs. Branded id schemas widen to plain `string` on
 * input, so a procedure's input type is what UI-side callers actually pass
 * (e.g. the un-branded `projectId` from `projectSubtreeTasksFilters`).
 */
export type RouterInputs = inferRouterInputs<TRPCRouter>;
