import {
  mailImportSettings,
  type MailImportSettings,
  type SetMailImportInput,
} from "@cubby/schemas/mail-import-settings";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
  type RepositoryQueryInput,
} from "~/server/db/repository-access.boundary";
import { appSettings } from "~/server/db/retained-tables";

const SETTINGS_ID = "00000000-0000-4000-8000-000000000078";

export async function readMailImportSettings(
  db: RepositoryQueryInput,
  lock = false,
): Promise<MailImportSettings> {
  const query = getDb(db)
    .select({ metadata: appSettings.metadata })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID));
  const [row] = await (lock ? query.for("update") : query);
  return row
    ? mailImportSettings.parse(row.metadata)
    : { enabledMailboxes: [], controlledPauses: [] };
}

export const mailImportEnabled = async (
  db: RepositoryQueryInput,
  mailboxId: string,
  lock = false,
) =>
  (await readMailImportSettings(db, lock)).enabledMailboxes.includes(mailboxId);

export async function setMailImport(
  db: Database,
  input: SetMailImportInput,
  options: { kind: "switch" | "controlled_pause" | "resume_controlled" } = {
    kind: "switch",
  },
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
      controlledPauses:
        input.enabled || options.kind === "resume_controlled"
          ? current.controlledPauses.filter(
              (pause) => pause.mailboxId !== input.mailboxId,
            )
          : options.kind === "controlled_pause"
            ? [
                ...current.controlledPauses.filter(
                  (pause) => pause.mailboxId !== input.mailboxId,
                ),
                {
                  mailboxId: input.mailboxId,
                  enabledBefore:
                    current.controlledPauses.find(
                      (pause) => pause.mailboxId === input.mailboxId,
                    )?.enabledBefore ??
                    current.enabledMailboxes.includes(input.mailboxId),
                },
              ]
            : current.controlledPauses.map((pause) =>
                pause.mailboxId === input.mailboxId
                  ? { ...pause, enabledBefore: input.enabled }
                  : pause,
              ),
    };
    await getDb(tx)
      .update(appSettings)
      .set({ metadata: next, updatedAt: new Date() })
      .where(eq(appSettings.id, SETTINGS_ID));
    return next;
  });
}

/** Resume queued work without opting a previously disabled mailbox into automatic imports. */
export async function resumeControlledMailImport(
  db: Database,
  mailboxId: string,
): Promise<MailImportSettings> {
  return withTransactionDatabase(db, async (tx) => {
    const settings = await readMailImportSettings(tx, true);
    const pause = settings.controlledPauses.find(
      (entry) => entry.mailboxId === mailboxId,
    );
    if (!pause)
      throw new Error("This mailbox has no controlled-import pause to resume.");
    return setMailImport(
      tx,
      { mailboxId, enabled: pause.enabledBefore },
      { kind: "resume_controlled" },
    );
  });
}
