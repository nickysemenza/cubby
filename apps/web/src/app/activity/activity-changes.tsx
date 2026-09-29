import { type AuditEntityKind, auditEntitySchema } from "@cubby/schemas/audit";
import {
  AUDIT_CHANNELS,
  type AuditChannel,
  auditChannelSchema,
} from "@cubby/schemas/context";
import { auditableEntities } from "@cubby/schemas/entity-manifest";

import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { NativeSelect } from "~/components/ui/native-select";
import { entityPluralLabel } from "~/entities/entities";

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
    <Row as="label" align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Entity</span>
      <NativeSelect
        value={value ?? ""}
        onChange={(event) =>
          onChange(auditEntitySchema.safeParse(event.target.value).data)
        }
      >
        <option value="">All entities</option>
        {auditableEntities.map((entity) => (
          <option key={entity} value={entity}>
            {entityPluralLabel(entity)}
          </option>
        ))}
      </NativeSelect>
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
    <Row as="label" align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Channel</span>
      <NativeSelect
        value={value ?? ""}
        onChange={(event) =>
          onChange(auditChannelSchema.safeParse(event.target.value).data)
        }
      >
        <option value="">All channels</option>
        {AUDIT_CHANNELS.map((next) => (
          <option key={next} value={next}>
            {next}
          </option>
        ))}
      </NativeSelect>
    </Row>
  );
}
