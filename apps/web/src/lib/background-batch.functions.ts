import {
  backgroundBatchContract,
  backgroundJobContract,
} from "~/contracts/background-batch.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const backgroundBatch = defineOperationDomain(backgroundBatchContract, {
  list: { tags: [["background-batch", "list"]] },
  summary: {
    tags: [["background-batch", "summary"]],
    cache: "live-status",
  },
  jobs: { tags: [["background-batch", "jobs"]] },
  retry: { invalidates: ripple.backgroundBatch },
  cancel: { invalidates: ripple.backgroundBatch },
});

export const backgroundJob = defineOperationDomain(backgroundJobContract, {
  retry: { invalidates: ripple.backgroundBatch },
  drain: { invalidates: ripple.backgroundBatch },
  strandedCount: { tags: [["background-batch", "stranded"]] },
  clearStranded: { invalidates: ripple.backgroundBatch },
});
