-- Preserve exact retained endpoint text while serving scoped matches from
-- small indexes instead of reopening every immutable evidence document.
CREATE INDEX "Assessment_connection_source_ref_idx" ON "Assessment"
 ((evidence #>> '{candidate,source,entityKind}'), (evidence #>> '{candidate,source,entityId}')) INCLUDE (id)
 WHERE served AND subject->>'scope' LIKE 'connection.%';
--> statement-breakpoint
CREATE INDEX "Assessment_connection_target_ref_idx" ON "Assessment"
 ((evidence #>> '{candidate,target,entityKind}'), (evidence #>> '{candidate,target,entityId}')) INCLUDE (id)
 WHERE served AND subject->>'scope' LIKE 'connection.%';
