import type { photoRunCandidatesResponse } from "@cubby/schemas/photo-import-run";
import { getErrorMessage } from "@cubby/shared";
import type { z } from "zod";

type Candidates = z.infer<typeof photoRunCandidatesResponse>;

/** Separate invocations bound per-request cache/usage subrequests without limiting total decisions. */
export async function loadPhotoRunCandidateChunks(
  groupKeys: readonly string[],
  request: (groupKeys: string[]) => Promise<Candidates>,
): Promise<Candidates> {
  const chunks: string[][] = [];
  for (let offset = 0; offset < groupKeys.length; offset += 6)
    chunks.push(groupKeys.slice(offset, offset + 6));
  const results = await Promise.all(
    chunks.map(async (keys) => {
      try {
        return await request(keys);
      } catch (error) {
        return {
          groups: keys.map((groupKey) => ({
            groupKey,
            status: "failed" as const,
            error: getErrorMessage(error),
            candidates: [],
            rejectedCandidates: [],
            selectedComparison: null,
          })),
        };
      }
    }),
  );
  return { groups: results.flatMap((result) => result.groups) };
}
