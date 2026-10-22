import { z } from "zod";

const identifiedRecord = z.object({ id: z.string() });

/** Entity-tree row keys may be namespaced; memberships retain canonical IDs. */
export function groupRecordIdentity(row: {
  id: string;
  original: unknown;
}): string {
  return identifiedRecord.safeParse(row.original).data?.id ?? row.id;
}
