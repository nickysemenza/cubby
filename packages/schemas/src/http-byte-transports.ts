import { z } from "zod";

import { initiateRunEvidenceUploadInput } from "./purchase-import";

/** Original-byte delivery stays outside JSON RPC; ownership is enforced by the source service. */
export const runEvidenceMediaRead = {
  operationId: "run.readEvidenceMedia",
  method: "GET",
  path: "/api/import/evidence",
  input: initiateRunEvidenceUploadInput
    .pick({ runId: true, targetId: true })
    .extend({ evidenceId: z.uuid() }),
} as const;

/** Byte routes participate in the same OpenAPI/native route generation as JSON operations. */
export const httpByteReads = [runEvidenceMediaRead] as const;
