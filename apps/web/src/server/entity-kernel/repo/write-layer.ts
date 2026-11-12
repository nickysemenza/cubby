import type { ActorContext } from "@cubby/schemas/context";
import type { ShortcodeType } from "@cubby/shared";

import type { DrizzleTransaction } from "~/server/db";
import {
  type AuditEntryInput,
  logAuditEntries,
} from "~/server/generic/audit-log/repo/audit-log";
import {
  EntityInsertLayer,
  type ShortcodeInsertValues,
  type StagedRowFor,
} from "~/server/generic/shortcode/repo/shortcode-utils";

/**
 * One write layer in the caller's transaction: entity creates of every kind
 * share one identity reservation and one insert per kind, and audit rows are
 * written once per actor when the layer finishes. Standalone writers use a
 * layer of their own, so a one-item call writes the same rows and audits.
 */
export class WriteLayer {
  private readonly entities: EntityInsertLayer;
  private readonly audits: {
    actor: ActorContext;
    entries: AuditEntryInput[];
  }[] = [];

  constructor(readonly tx: DrizzleTransaction) {
    this.entities = new EntityInsertLayer(tx);
  }

  stage<T extends ShortcodeType>(
    entity: T,
    values: readonly ShortcodeInsertValues<T>[],
  ): StagedRowFor<T>[] {
    return this.entities.stage(entity, values);
  }

  insert<T extends ShortcodeType>(entity: T, rows: readonly StagedRowFor<T>[]) {
    return this.entities.insert(entity, rows);
  }

  audit(actor: ActorContext, entries: readonly AuditEntryInput[]) {
    if (!entries.length) return;
    const existing = this.audits.find((group) => group.actor === actor);
    if (existing) existing.entries.push(...entries);
    else this.audits.push({ actor, entries: [...entries] });
  }

  /** Write every staged audit row; call after the layer's last payload. */
  async flushAudits() {
    for (const { actor, entries } of this.audits.splice(0))
      await logAuditEntries(this.tx, actor, entries);
  }
}
