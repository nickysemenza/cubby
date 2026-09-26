import {
  runBrowserListInput,
  type RunFilters,
  type RunOut,
} from "@cubby/schemas/run";

import type { ListQueryOptionsFn } from "~/app/_components/hooks/usePaginatedTableCore";
import { run } from "~/entities/run.functions";

import { defineListOverride } from "./types";

/**
 * The Runs list is not a kernel list (a Run has no create/update contract):
 * its rows come from the `run.list` read, which runs the kernel's own
 * run list, like image's source.
 */
const runListSource: ListQueryOptionsFn<RunFilters, RunOut> = (params) => {
  const input = runBrowserListInput.parse(params);
  const policy = run.list.policy(input);
  return {
    queryKey: run.list.queryKey(input),
    meta: policy.meta,
    execute: (signal) => run.list.call(input, { signal }),
  };
};

export const runListOverride = defineListOverride<RunOut, RunFilters>({
  use: () => ({ source: runListSource }),
});
