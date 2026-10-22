import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import { unparsedStartOperationDataSchema } from "~/server/operation-runtime/start-operation.contract";
import { dispatchWorkflowStream } from "~/server/operation-runtime/workflow-stream-dispatch.boundary";

/** Domain input validation remains inside the authenticated operation span. */
// The recursive carrier is runtime-validated; Start's output mapped type cannot
// express its readonly Map/Set branches. Input validation remains strict.
export const callWorkflowStream = createServerFn({
  method: "POST",
  strict: { output: false },
})
  .validator(
    z.object({
      operation: z.string(),
      input: unparsedStartOperationDataSchema,
    }),
  )
  .handler(({ data }) =>
    dispatchWorkflowStream(data.operation, getRequest(), data.input),
  );
