import { z } from "zod";

import { runShortcode } from "./identifier-fields";

/** Original-byte delivery stays outside JSON RPC; ownership is enforced by the source service. */
export const runEvidenceMediaRead = {
  operationId: "run.readEvidenceMedia",
  method: "GET",
  path: "/api/import/evidence",
  input: z.object({
    runId: runShortcode,
    targetId: z.uuid(),
    evidenceId: z.uuid(),
  }),
} as const;

/** Byte routes participate in the same OpenAPI/native route generation as JSON operations. */
export const httpByteReads = [runEvidenceMediaRead] as const;
