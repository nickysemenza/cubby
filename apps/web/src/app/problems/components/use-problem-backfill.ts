import type { UseMutationOptions } from "@tanstack/react-query";

// Shared type helpers for the Problems-page mutation wrappers. The "fix all"
// buttons now stream their progress (see `problem-backfill-action.tsx`); these
// generic helpers remain for the per-card wrapper (`useProblemCardMutation`),
// which recovers a mutation's data type from its `*.mutationOptions` reference.

/** A tRPC `*.mutationOptions` reference, e.g. `api.problems.reparseStale.mutationOptions`. */
export type MutationOptionsFn = (opts: never) => UseMutationOptions<
  // biome-ignore lint/suspicious/noExplicitAny: positions only used as inference anchors
  any,
  // biome-ignore lint/suspicious/noExplicitAny: positions only used as inference anchors
  any,
  // biome-ignore lint/suspicious/noExplicitAny: positions only used as inference anchors
  any
>;

/** The mutation's success-result type, recovered from the options it produces. */
export type DataOf<TFn extends MutationOptionsFn> =
  ReturnType<TFn> extends UseMutationOptions<infer TData, infer _E, infer _V>
    ? TData
    : never;
