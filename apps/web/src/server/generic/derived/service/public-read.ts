import {
  fieldEnvelopeReadSchema,
  type FieldEnvelopeEntity,
  type EntityFieldEnvelopeRead,
} from "@cubby/schemas/entity-field-envelopes";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { withUniversalEntityMedia } from "~/server/entity-kernel/repo/entity-display-image";
import {
  publicFieldEnvelopeRows,
  loadPublicFieldReadContexts,
} from "~/server/generic/derived/repo/public-read";
import type { PageFieldReadContexts } from "~/server/generic/derived/repo/read-context";

const publicIdentity = z.object({ id: z.string() });

/** Batch public serialization shared by specialist operations and entity reads. */
export async function readPublicEntityRows<
  E extends FieldEnvelopeEntity & ShortcodeEntity,
  P extends "output" | "list" | "detail",
>({
  db,
  entity,
  projection,
  rows,
  contexts,
}: {
  db: Database | DrizzleTransaction;
  entity: E;
  projection: P;
  rows: readonly unknown[];
  contexts?: PageFieldReadContexts;
}): Promise<EntityFieldEnvelopeRead<E, P>[]> {
  const schema = fieldEnvelopeReadSchema(entity, projection);
  const [hydrated, current] = await Promise.all([
    projection === "output"
      ? Promise.resolve(rows)
      : withUniversalEntityMedia(db, entity, rows, projection === "detail"),
    contexts ??
      loadPublicFieldReadContexts(
        db,
        entity,
        rows.map((row) => publicIdentity.parse(row).id),
      ),
  ]);
  return publicFieldEnvelopeRows({
    db,
    entity,
    schema,
    rows: hydrated,
    contexts: current,
  });
}

/** Unary command results use the same serializer; page callers retain the batched entry point. */
export async function readPublicEntityRow<
  E extends FieldEnvelopeEntity & ShortcodeEntity,
  P extends "output" | "list" | "detail",
>({
  row,
  ...options
}: Omit<Parameters<typeof readPublicEntityRows<E, P>>[0], "rows"> & {
  row: unknown;
}): Promise<EntityFieldEnvelopeRead<E, P>> {
  const rows = await readPublicEntityRows({ ...options, rows: [row] });
  const result = rows[0];
  if (!result) throw new Error("A unary public entity read produced no row");
  return result;
}
