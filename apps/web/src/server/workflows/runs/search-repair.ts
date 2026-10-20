import { z } from "zod";

import {
  getSearchIndexRepairWorkflow,
  getWorkerVersion,
} from "~/server/cf-env";
import type { Database } from "~/server/db";
import type { SearchIndexRepairWorkflowParams } from "~/server/worker-bindings";

import { SEARCH_INDEX_REPAIR_RETENTION } from "../search-index-repair-retention";
import { activatedWorkflowIdentity } from "./launcher";

const batchResult = z.object({
  created: z.array(z.object({ id: z.string() })),
  errors: z.array(
    z.object({ index: z.number(), code: z.number(), message: z.string() }),
  ),
});
type SearchRepairDispatch = {
  id: string;
  params: SearchIndexRepairWorkflowParams;
};
type SearchRepairPort = {
  version: typeof getWorkerVersion;
  createBatch(
    input: Parameters<
      NonNullable<
        ReturnType<typeof getSearchIndexRepairWorkflow>
      >["createBatch"]
    >[0],
  ): Promise<z.infer<typeof batchResult>>;
};
const productionPort: SearchRepairPort = {
  version: getWorkerVersion,
  createBatch: async (
    input: Parameters<
      NonNullable<
        ReturnType<typeof getSearchIndexRepairWorkflow>
      >["createBatch"]
    >[0],
  ) => {
    const binding = getSearchIndexRepairWorkflow();
    if (!binding)
      throw new Error("Search repair Workflow binding is not configured");
    return batchResult.parse(await binding.createBatch(input));
  },
};

export async function continueSearchRepair(
  db: Database,
  input: SearchRepairDispatch,
  port = productionPort,
): Promise<void> {
  const identity = await activatedWorkflowIdentity(db, port.version());
  const result = batchResult.parse(
    await port.createBatch({
      instances: [
        {
          ...input,
          params: {
            ...input.params,
            activationEpoch: identity.activationEpoch,
          },
          retention: SEARCH_INDEX_REPAIR_RETENTION,
        },
      ],
    }),
  );
  if (
    result.created.some((instance) => instance.id === input.id) ||
    result.errors.some((error) => error.index === 0 && error.code === 10405)
  )
    return;
  throw new Error(
    `Search repair successor ${input.id} was not created: ${JSON.stringify(result.errors)}`,
  );
}
