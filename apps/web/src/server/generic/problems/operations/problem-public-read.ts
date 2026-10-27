import { problemsTypeSliceOut } from "@cubby/schemas/mcp";
import { problemLiveReadProjections } from "@cubby/schemas/problems";
import { z } from "zod";

import type { Database } from "~/server/db";
import { publicFieldEnvelopeBatch } from "~/server/generic/derived/repo/public-read";

const rowRecord = z.record(z.string(), z.unknown());
const rowsSchema = z.array(rowRecord);
const sliceSchema = z
  .object({ type: z.string(), items: rowsSchema })
  .passthrough();

/** Each response loads current facts once across its selected detector groups. */
export async function publicProblemGroups<S extends z.ZodType>(
  db: Database,
  value: unknown,
  schema: S,
): Promise<z.output<S>> {
  const groups = rowRecord.parse(value);
  const reads: Array<
    Parameters<typeof publicFieldEnvelopeBatch>[0]["reads"][number]
  > = [];
  const positions: { key: string; index: number }[] = [];
  const rowsByKey = new Map<string, z.output<typeof rowsSchema>>();
  for (const [key, projection] of Object.entries(problemLiveReadProjections)) {
    if (!(key in groups)) continue;
    const rows = rowsSchema.parse(groups[key]);
    groups[key] = rows;
    rowsByKey.set(key, rows);
    for (const [index, row] of rows.entries()) {
      // Detector observations explain membership even if current derived facts have moved on.
      const observation =
        "observation" in projection.schema.shape
          ? projection.schema.shape.observation
          : undefined;
      reads.push({
        ...projection,
        row: observation
          ? { ...row, observation: observation.parse(row) }
          : row,
      });
      positions.push({ key, index });
    }
  }
  const serialized = await publicFieldEnvelopeBatch({ db, reads });
  for (const [index, position] of positions.entries()) {
    const rows = rowsByKey.get(position.key);
    if (!rows) throw new Error("Missing Problems group");
    const row = serialized[index];
    if (!row) throw new Error("Missing serialized Problems row");
    rows[position.index] = row;
    groups[position.key] = rows;
  }
  return schema.parse(groups);
}

export async function publicProblemSlice(
  db: Database,
  value: unknown,
  page?: { pageIndex: number; pageSize: number },
) {
  const raw = sliceSchema.parse(value);
  // Only the requested page needs authoritative current field facts.
  const start = page ? page.pageIndex * page.pageSize : 0;
  const slice = page
    ? { ...raw, items: raw.items.slice(start, start + page.pageSize) }
    : raw;
  const groups = await publicProblemGroups(
    db,
    { [slice.type]: slice.items },
    rowRecord,
  );
  return problemsTypeSliceOut.parse({ ...slice, items: groups[slice.type] });
}
