import type { AuditLogListOut } from "@cubby/schemas/audit";

type AuditLogEntry = AuditLogListOut["entries"][number];

export type FoldableAuditEntry = Pick<
  AuditLogEntry,
  | "entryKey"
  | "entityKind"
  | "entityId"
  | "action"
  | "userId"
  | "channel"
  | "oauthClient"
  | "device"
  | "runId"
  | "createdAt"
  | "changes"
>;

/** Edits further apart than this read as separate events. */
const FOLD_WINDOW_MS = 10 * 60_000;

const sameWriter = (a: FoldableAuditEntry, b: FoldableAuditEntry) =>
  a.userId === b.userId &&
  a.channel === b.channel &&
  a.oauthClient?.id === b.oauthClient?.id &&
  a.device?.id === b.device?.id &&
  a.runId === b.runId;

/**
 * Consecutive updates to one record by the same writer (person, client,
 * device and run) within ten minutes of each other fold into one group, so a
 * burst of saves reads as one event. Every other entry stands alone. Entries
 * arrive newest first and keep that order.
 */
export function foldAuditEntries<Entry extends FoldableAuditEntry>(
  entries: readonly Entry[],
): Entry[][] {
  const groups: Entry[][] = [];
  for (const entry of entries) {
    const group = groups.at(-1);
    const previous = group?.at(-1);
    if (
      group &&
      previous &&
      entry.action === "update" &&
      previous.action === "update" &&
      entry.entityKind === previous.entityKind &&
      entry.entityId === previous.entityId &&
      sameWriter(entry, previous) &&
      Math.abs(previous.createdAt.getTime() - entry.createdAt.getTime()) <=
        FOLD_WINDOW_MS
    ) {
      group.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups;
}

/** The distinct fields a folded group changed. */
export const foldedFields = (group: readonly FoldableAuditEntry[]) =>
  new Set(group.flatMap((entry) => Object.keys(entry.changes ?? {})));
