import { auditEntitySchema } from "@cubby/schemas/audit";
import { useState } from "react";

import { AuditLogList } from "~/entity/audit-log/audit-log-list";
import { Picker } from "~/ui/combobox/picker";

/** The audit provenance is the source for Cubby's changes, scoped like history. */
export function AutomaticChanges({ record }: { record?: string }) {
  const [entity, setEntity] = useState<string | null>(null);
  return (
    <section aria-label="Changes by Cubby" className="grid gap-2">
      <Picker
        mode="choose"
        label="Change kind"
        placeholder="All changes"
        clearable
        options={auditEntitySchema.options.map((value) => ({
          value,
          label: value,
        }))}
        value={entity}
        onValueChange={setEntity}
      />
      <AuditLogList
        cubbyChanges
        channel="system"
        entityKind={auditEntitySchema.safeParse(entity).data}
        entityId={record}
      />
    </section>
  );
}
