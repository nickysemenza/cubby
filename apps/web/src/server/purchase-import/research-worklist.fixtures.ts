import {
  researchWorkResolve,
  type ResearchWorkResolution,
} from "@cubby/schemas/research-tools";
import { fromPartial } from "@total-typescript/shoehorn";
import { z } from "zod";

import type { Database } from "~/server/db";

import { resolveImportResearch } from "./research-import";
import { retainResearchObservation } from "./research-observations";
import { researchServiceFor } from "./research-service";

const assignedWork = z
  .object({
    status: z.literal("working"),
    work: z.object({ workRef: z.uuid(), kind: z.string() }).passthrough(),
  })
  .passthrough();

// Database admission, retention and resolution remain real. Only the source
// object store and semantic source assessment are external synthetic seams.
export function researchWorklistFixture(db: Database, runId: string) {
  const objects = new Map<string, string>();
  const storage = {
    put: async (key: string, bytes: Uint8Array) => {
      objects.set(key, new TextDecoder().decode(bytes));
    },
    get: async (key: string) => {
      const content = objects.get(key);
      if (content === undefined)
        throw new Error("Synthetic retained source missing");
      return content;
    },
  };
  const services = researchServiceFor(db, fromPartial<Env>({}), runId, {
    observations: { storage },
  });
  return {
    next: () => services.researchNext({}, crypto.randomUUID()),
    assigned: async () =>
      assignedWork.parse(await services.researchNext({}, crypto.randomUUID()))
        .work,
    retain: (
      workRef: string,
      content: string,
      callId: string = crypto.randomUUID(),
    ) =>
      retainResearchObservation(
        db,
        {
          runId,
          workRef,
          callId,
          kind: "web_page",
          sourceMetadata: {
            sourceURL: "https://shop.example.test/orders",
            title: "Synthetic account history",
          },
          content,
        },
        { storage, keyPrefix: "synthetic-research-worklist" },
      ),
    resolve: (
      workRef: string,
      input: {
        status: ResearchWorkResolution["status"];
        evidenceIds?: string[];
        scopeExhausted?: boolean;
        gaps?: string[];
        callId?: string;
      },
    ) => {
      const evidenceIds = input.evidenceIds ?? [];
      const proposal = researchWorkResolve.parse({
        workRef,
        status: input.status,
        identity: {
          evidenceIds,
          reasoning: "Synthetic selected research scope only.",
        },
        detail: "Synthetic account scope assessment.",
        progress: {
          scopeExhausted: input.scopeExhausted ?? false,
          evidenceIds,
          gaps: input.gaps ?? [],
        },
      });
      return resolveImportResearch(
        db,
        {
          runId,
          workRef,
          callId: input.callId ?? crypto.randomUUID(),
          proposal,
        },
        {
          readEvidence: (evidence) => storage.get(evidence.objectKey),
          assess: async () => ({
            identityVerified: false,
            scopeCompletionVerified: input.scopeExhausted ?? false,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [],
            rejected: [],
          }),
        },
      );
    },
  };
}
