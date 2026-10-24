import {
  mailImportSettings,
  type MailImportSettings,
  type SetMailImportInput,
} from "@cubby/schemas/mail-import-settings";
import { eq } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { getDb, unwrapDb, withTransactionDatabase } from "~/server/db/helpers";
import { appSettings } from "~/server/db/schema";

const SETTINGS_ID = "00000000-0000-4000-8000-000000000078";

export async function readMailImportSettings(
  db: Database | DrizzleTransaction,
  lock = false,
): Promise<MailImportSettings> {
  const query = unwrapDb(db)
    .select({ metadata: appSettings.metadata })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID));
  const [row] = await (lock ? query.for("update") : query);
  return row
    ? mailImportSettings.parse(row.metadata)
    : { enabledMailboxes: [] };
}

export const mailImportEnabled = async (
  db: Database | DrizzleTransaction,
  mailboxId: string,
  lock = false,
) =>
  (await readMailImportSettings(db, lock)).enabledMailboxes.includes(mailboxId);

export async function setMailImport(
  db: Database,
  input: SetMailImportInput,
): Promise<MailImportSettings> {
  return withTransactionDatabase(db, async (tx) => {
    await getDb(tx)
      .insert(appSettings)
      .values({ id: SETTINGS_ID, metadata: { enabledMailboxes: [] } })
      .onConflictDoNothing();
    const [row] = await getDb(tx)
      .select({ metadata: appSettings.metadata })
      .from(appSettings)
      .where(eq(appSettings.id, SETTINGS_ID))
      .for("update");
    const current = mailImportSettings.parse(row?.metadata);
    const others = current.enabledMailboxes.filter(
      (id) => id !== input.mailboxId,
    );
    const next = {
      enabledMailboxes: input.enabled
        ? [...others, input.mailboxId].sort()
        : others,
    };
    await getDb(tx)
      .update(appSettings)
      .set({ metadata: next, updatedAt: new Date() })
      .where(eq(appSettings.id, SETTINGS_ID));
    return next;
  });
}
