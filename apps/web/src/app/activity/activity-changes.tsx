import { type AuditEntityKind, auditEntitySchema } from "@cubby/schemas/audit";
import {
  AUDIT_CHANNELS,
  type AuditChannel,
  auditChannelSchema,
} from "@cubby/schemas/context";
import { auditableEntities } from "@cubby/schemas/entity-manifest";

import { entityPluralLabel } from "~/entity/entities";
import { AuditLogList } from "~/features/audit-log/audit-log-list";
import { Picker } from "~/ui/combobox/picker";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { Row, Stack } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";

const ENTITY_KIND_OPTIONS: readonly PickerOption[] = [
  { value: "", label: "All entities" },
  ...auditableEntities.map((entity) => ({
    value: entity,
    label: entityPluralLabel(entity),
  })),
];

const CHANNEL_OPTIONS: readonly PickerOption[] = [
  { value: "", label: "All channels" },
  ...AUDIT_CHANNELS.map((channel) => ({ value: channel, label: channel })),
];

export function ActivityChanges({
  entityKind,
  channel,
  onEntityKindChange,
  onChannelChange,
  onClear,
}: {
  entityKind: AuditEntityKind | undefined;
  channel: AuditChannel | undefined;
  onEntityKindChange: (entityKind: AuditEntityKind | undefined) => void;
  onChannelChange: (channel: AuditChannel | undefined) => void;
  onClear: () => void;
}) {
  return (
    <Stack gap="sm" className="w-full">
      <Row justify="between" align="center" gap="sm" wrap>
        <p className="text-muted-foreground">
          Recent changes across all entities.
        </p>
        <Row gap="sm" wrap>
          <EntityKindFilter value={entityKind} onChange={onEntityKindChange} />
          <ChannelFilter value={channel} onChange={onChannelChange} />
          {entityKind || channel ? (
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear
            </Button>
          ) : null}
        </Row>
      </Row>
      <AuditLogList showEntityLink entityKind={entityKind} channel={channel} />
    </Stack>
  );
}

function EntityKindFilter({
  value,
  onChange,
}: {
  value: AuditEntityKind | undefined;
  onChange: (entityKind: AuditEntityKind | undefined) => void;
}) {
  return (
    <Row align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Entity</span>
      <Picker
        label="Entity"
        options={ENTITY_KIND_OPTIONS}
        value={value ?? ""}
        onValueChange={(next) =>
          onChange(auditEntitySchema.safeParse(next ?? "").data)
        }
        className="w-44"
      />
    </Row>
  );
}

function ChannelFilter({
  value,
  onChange,
}: {
  value: AuditChannel | undefined;
  onChange: (channel: AuditChannel | undefined) => void;
}) {
  return (
    <Row align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Channel</span>
      <Picker
        mode="choose"
        label="Channel"
        options={CHANNEL_OPTIONS}
        value={value ?? ""}
        onValueChange={(next) =>
          onChange(auditChannelSchema.safeParse(next ?? "").data)
        }
        className="w-36"
      />
    </Row>
  );
}
