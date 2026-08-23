import { type AuditEntityType, auditEntitySchema } from "@cubby/schemas/audit";
import type { BackgroundBatchSummary } from "@cubby/schemas/background-jobs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface BackgroundEntityRef {
  entityType: AuditEntityType;
  entityId: string;
}

function parseBackgroundEntityRef(value: unknown): BackgroundEntityRef | null {
  if (!isRecord(value)) return null;
  const { entityType, entityId } = value;
  if (typeof entityType !== "string" || typeof entityId !== "string") {
    return null;
  }
  const parsedEntityType = auditEntitySchema.safeParse(entityType);
  if (!parsedEntityType.success) return null;
  return { entityType: parsedEntityType.data, entityId };
}

function batchFilterText(batch: BackgroundBatchSummary): string {
  const metadata = isRecord(batch.metadata) ? batch.metadata : null;
  const entity = parseBackgroundEntityRef(metadata?.entity);
  return [
    batch.id,
    batch.kind,
    batch.source,
    batch.processor,
    batch.status,
    typeof metadata?.source === "string" ? metadata.source : "",
    entity?.entityType ?? "",
    entity?.entityId ?? "",
    JSON.stringify(batch.metadata ?? ""),
  ]
    .join(" ")
    .toLowerCase();
}

export { batchFilterText, isRecord, parseBackgroundEntityRef };
