import { type AuditEntityType, auditEntitySchema } from "@cubby/schemas/audit";
import {
  APPLICATION_AUDIT_SOURCES,
  type AuditSource,
  auditSourceSchema,
} from "@cubby/schemas/context";
import { auditableEntities } from "@cubby/schemas/entity-manifest";

import { AuditLogList } from "~/app/_components/audit-log/audit-log-list";
import { Row, Stack } from "~/components/layout";
import { NativeSelect } from "~/components/ui/native-select";
import { entityPluralLabel } from "~/entities/entities";

export function ActivityChanges({
  entityType,
  source,
  onEntityTypeChange,
  onSourceChange,
}: {
  entityType: AuditEntityType | undefined;
  source: AuditSource | undefined;
  onEntityTypeChange: (entityType: AuditEntityType | undefined) => void;
  onSourceChange: (source: AuditSource | undefined) => void;
}) {
  return (
    <Stack className="max-w-3xl">
      <Row justify="between" align="center" gap="sm" wrap>
        <p className="text-muted-foreground">
          Recent changes across all entities.
        </p>
        <Row gap="sm" wrap>
          <EntityTypeFilter value={entityType} onChange={onEntityTypeChange} />
          <SourceFilter value={source} onChange={onSourceChange} />
        </Row>
      </Row>
      <AuditLogList showEntityLink entityType={entityType} source={source} />
    </Stack>
  );
}

function EntityTypeFilter({
  value,
  onChange,
}: {
  value: AuditEntityType | undefined;
  onChange: (entityType: AuditEntityType | undefined) => void;
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

function SourceFilter({
  value,
  onChange,
}: {
  value: AuditSource | undefined;
  onChange: (source: AuditSource | undefined) => void;
}) {
  return (
    <Row as="label" align="center" gap="sm" className="w-fit text-sm">
      <span className="text-muted-foreground">Source</span>
      <NativeSelect
        value={value ?? ""}
        onChange={(event) =>
          onChange(auditSourceSchema.safeParse(event.target.value).data)
        }
      >
        <option value="">All sources</option>
        {APPLICATION_AUDIT_SOURCES.map((next) => (
          <option key={next} value={next}>
            {next}
          </option>
        ))}
      </NativeSelect>
    </Row>
  );
}
