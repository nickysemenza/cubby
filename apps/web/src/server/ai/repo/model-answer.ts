import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { answer } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import type { AskKind } from "~/server/kernel/api";
import { askEnvelope, inputHashOf } from "~/server/kernel/envelope";

/** Read metadata for a replay without requesting another producer call. */
export async function readModelAnswer<I, O>(
  db: Database,
  kind: AskKind<I, O>,
  input: I,
) {
  const inputHash = await inputHashOf(askEnvelope(kind, input));
  const [stored] = await repositoryQueries(db)
    .select()
    .from(answer)
    .where(eq(answer.inputHash, inputHash));
  return stored
    ? { ...stored, output: kind.output.parse(stored.output) }
    : null;
}
