import { entitySummary } from "@cubby/schemas/entity-summary";
import { humanize } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { derived } from "~/integrations/tanstack-query/generated/catalog/derived.gen";
import { RecordList, RecordRow } from "~/ui/common/record-list";

/** The shell status slot's derived backlog: shown only while values are updating. */
export function DerivedBacklogStatus({
  compact = false,
}: {
  compact?: boolean;
}) {
  const { data } = useQuery(derived.backlog.queryOptions({}));
  if (!data?.total) return null;
  const label = `Updating ${data.total} values`;
  return (
    <Link
      to="/activity"
      hash="derived-values"
      aria-label={compact ? label : undefined}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-info" />
      {!compact && <span>{label}</span>}
    </Link>
  );
}

export function DerivedBacklogOverview() {
  const result = useQuery(derived.backlog.queryOptions({}));
  return (
    <RecordList
      state={
        result.isPending
          ? { status: "pending", rows: 2 }
          : result.isError
            ? {
                status: "error",
                error: result.error,
                title: "Couldn't load derived values",
                onRetry: () => void result.refetch(),
              }
            : { status: "success" }
      }
      empty={<span>No values waiting to update.</span>}
    >
      {result.data?.kinds.map((kind) => (
        <RecordRow
          key={`${kind.entity}.${kind.field}`}
          primary={`${entitySummary[kind.entity].singular} · ${humanize(kind.field)}`}
          trailing={`${kind.count} updating`}
        />
      ))}
    </RecordList>
  );
}
