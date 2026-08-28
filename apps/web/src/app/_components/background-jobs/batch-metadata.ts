import { auditEntitySchema } from "@cubby/schemas/audit";
import type { BackgroundBatchSummary } from "@cubby/schemas/background-jobs";
import { z } from "zod";

const backgroundEntityRefSchema = z.object({
  entityType: auditEntitySchema,
  entityId: z.string(),
});
const backgroundMetadataSchema = z.object({
  source: z.string().optional(),
  entity: backgroundEntityRefSchema.optional(),
});

type BackgroundEntityRef = z.output<typeof backgroundEntityRefSchema>;
type BackgroundMetadata = z.output<typeof backgroundMetadataSchema>;
type BatchMetadataInput = BackgroundBatchSummary["metadata"];

function parseBackgroundMetadata(
  value: BatchMetadataInput,
): BackgroundMetadata | null {
  const parsed = backgroundMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseBackgroundEntityRef(
  value: BatchMetadataInput,
): BackgroundEntityRef | null {
  const parsed = backgroundEntityRefSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function batchFilterText(batch: BackgroundBatchSummary): string {
  return [
    batch.id,
    batch.kind,
    batch.source,
    batch.processor,
    batch.status,
    JSON.stringify(batch.metadata ?? ""),
  ]
    .join(" ")
    .toLowerCase();
}

export { batchFilterText, parseBackgroundEntityRef, parseBackgroundMetadata };
