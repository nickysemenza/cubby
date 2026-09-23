import type { EntityConnectionGroup } from "@cubby/schemas/entity-connections";
import type { OperationEffect } from "@cubby/schemas/entity-integrity";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ErrorDisplay } from "~/components/feedback/error-display";
import { Stack } from "~/components/layout";
import { entityGraph } from "~/entities/entity-graph.functions";
import { cn } from "~/lib/utils";

/**
 * Short verb phrase for a disposition's `effect`, from the delete/merge
 * survivor's point of view. `operation` only changes the `block` phrasing —
 * every other effect reads the same regardless of which operation triggered it.
 */
function dispositionPhrase(
  effect: OperationEffect,
  operation: "delete" | "merge",
): string {
  switch (effect) {
    case "block":
      return `Blocks the ${operation}`;
    case "soft-delete":
      return "Deleted with it";
    case "hard-delete":
      return "Permanently removed with it";
    case "detach":
      return "Link is cleared";
    case "repoint":
      return "Moves to the survivor";
    case "move-dedupe":
      return "Merged into the matching record";
    case "preserve":
      return "Kept as history";
  }
}

/** Test-injectable seam for the `connections` query; defaults to production. */
export type ImpactPreviewOperations = {
  connections?: typeof entityGraph.connections;
};

/**
 * Incoming-connection impact for one entity, given the requested operation's
 * declared dispositions. Advisory only — the caller must never disable or
 * change its confirm action based on this preview; the mutation's structured
 * refusal (a `block` disposition surfacing as an error) stays the authority.
 */
function useConnectionImpact(
  id: string,
  operation: "delete" | "merge",
  operations?: ImpactPreviewOperations,
) {
  const connectionsOp = operations?.connections ?? entityGraph.connections;
  return useQuery(
    connectionsOp.queryOptions({ id, operation, limitPerGroup: 5 }),
  );
}

/** One entity's incoming groups with a disposition phrase, or its load state. */
function ImpactRow({
  id,
  operation,
  heading,
  operations,
}: {
  id: string;
  operation: "delete" | "merge";
  heading?: ReactNode;
  operations?: ImpactPreviewOperations;
}) {
  const query = useConnectionImpact(id, operation, operations);
  if (query.isPending)
    return (
      <p className="text-xs text-muted-foreground">Checking connections…</p>
    );
  if (query.isError)
    return (
      <ErrorDisplay
        error={query.error}
        title="connection impact"
        onRetry={() => void query.refetch()}
      />
    );
  const incoming = query.data.groups.filter(
    (group) => group.direction === "incoming" && group.count > 0,
  );
  if (incoming.length === 0) return null;
  return (
    <Stack gap="xs" className="min-w-0">
      {heading}
      <ConnectionImpactGroups groups={incoming} operation={operation} />
    </Stack>
  );
}

function ConnectionImpactGroups({
  groups,
  operation,
}: {
  groups: readonly EntityConnectionGroup[];
  operation: "delete" | "merge";
}) {
  return (
    <ul className="min-w-0 space-y-1 text-xs">
      {groups.map((group) => {
        const blocking = group.disposition?.effect === "block";
        return (
          <li
            key={group.edgeKey}
            className={cn("min-w-0", blocking && "text-destructive")}
          >
            <span className="font-medium">{group.label}</span> ({group.count}) —{" "}
            <span>
              {group.disposition
                ? dispositionPhrase(group.disposition.effect, operation)
                : "No impact recorded"}
            </span>
            {group.disposition?.description && (
              <span className="block text-muted-foreground">
                {group.disposition.description}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Delete impact preview for a single entity: its incoming connections and
 * what the delete would do to each, per the server's declared dispositions.
 * Advisory — it never disables or changes the caller's confirm action; the
 * delete itself re-checks before it runs.
 */
export function DeleteImpactPreview({
  id,
  operations,
}: {
  id: string;
  operations?: ImpactPreviewOperations;
}) {
  return (
    <Stack gap="sm" className="min-w-0 border-t border-border pt-2">
      <ImpactRow
        id={id}
        operation="delete"
        operations={operations}
        heading={
          <p className="text-xs font-medium text-muted-foreground">
            Connections affected
          </p>
        }
      />
      <p className="text-xs text-muted-foreground">
        This preview is advisory; the delete re-checks before it runs.
      </p>
    </Stack>
  );
}

/** Impact preview for several merge losers at once, with one shared note. */
export function MergeImpactPreview({
  losers,
  operations,
}: {
  losers: readonly { id: string; label: ReactNode }[];
  operations?: ImpactPreviewOperations;
}) {
  if (losers.length === 0) return null;
  return (
    <Stack gap="sm" className="min-w-0 border-t border-border pt-2">
      <p className="text-xs font-medium text-muted-foreground">
        Connections affected
      </p>
      {losers.map((loser) => (
        <ImpactRow
          key={loser.id}
          id={loser.id}
          operation="merge"
          operations={operations}
          heading={
            <p className="min-w-0 truncate text-xs font-medium">
              {loser.label}
            </p>
          }
        />
      ))}
      <p className="text-xs text-muted-foreground">
        This preview is advisory; the merge re-checks before it runs.
      </p>
    </Stack>
  );
}
