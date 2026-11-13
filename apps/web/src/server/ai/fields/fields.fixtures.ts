/** Synthetic seeds pass field assignments through the same boundary as writers. */
import { systemActor } from "@cubby/schemas/context";
import type { ShortcodeType } from "@cubby/shared";

import type { Database } from "~/server/db/database";
import { withTransactionDatabase } from "~/server/db/helpers";
import {
  insertWithShortcode,
  type ShortcodeInsertValues,
  type ShortcodeGeneratorPort,
  type ShortcodeRowFor,
} from "~/server/generic/shortcode/repo/shortcode-utils";

import { holdFieldsValues } from "./repo/field-decisions";

export async function insertFieldsFixture<T extends ShortcodeType>(
  db: Database,
  entity: T,
  values: ShortcodeInsertValues<T>,
  generator?: ShortcodeGeneratorPort,
): Promise<ShortcodeRowFor<T>> {
  return withTransactionDatabase(db, async (tx) => {
    const held = holdFieldsValues(entity, values, "create");
    const row = await insertWithShortcode(tx, entity, held.values, generator);
    if (!row.id) throw new Error("Synthetic seed has no identity");
    await held.settle(tx, systemActor(), row.id);
    return {
      ...row,
      ...Object.fromEntries(
        Object.entries(values).filter(([key]) => held.held.includes(key)),
      ),
    };
  });
}
