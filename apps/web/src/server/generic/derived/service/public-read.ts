import {
  fieldEnvelopeReadSchema,
  type FieldEnvelopeEntity,
  type EntityFieldEnvelopeRead,
} from "@cubby/schemas/entity-field-envelopes";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";

import type { Database, DrizzleTransaction } from "~/server/db";
import { withUniversalEntityMedia } from "~/server/entity-kernel/repo/entity-display-image";
import { publicFieldEnvelopeRows } from "~/server/generic/derived/repo/public-read";
import type { PageFieldReadContexts } from "~/server/generic/derived/repo/read-context";

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
  const hydrated =
    projection === "output"
      ? rows
      : await withUniversalEntityMedia(
          db,
          entity,
          rows,
          projection === "detail",
        );
  return publicFieldEnvelopeRows({
    db,
    entity,
    schema,
    rows: hydrated,
    contexts,
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
