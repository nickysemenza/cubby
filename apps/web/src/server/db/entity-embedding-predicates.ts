import { embeddingArtifactState } from "@cubby/schemas/derived-refresh";
import { sql, type AnyColumn, type SQL } from "drizzle-orm";

import { sqlEnumConstant } from "./sql-enum";

/**
 * Artifacts whose remote vector still needs a delete submission. The cleanup
 * query and `EntityEmbedding_cleanup_idx` share this text with inlined enum
 * constants: bound parameters would stop the planner proving the partial
 * index predicate.
 */
export function vectorCleanupPendingSql(table: {
  deletionId: AnyColumn;
  deletedAt: AnyColumn;
  artifactState: AnyColumn;
}): SQL {
  return sql`${table.deletionId} IS NULL AND (${table.deletedAt} IS NOT NULL OR ${table.artifactState} IN (${sqlEnumConstant(embeddingArtifactState, "retired")},${sqlEnumConstant(embeddingArtifactState, "failed")})) AND ${table.artifactState} <> ${sqlEnumConstant(embeddingArtifactState, "selected")}`;
}
