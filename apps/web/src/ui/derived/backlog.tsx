import { entitySummary } from "@cubby/schemas/entity-summary";
import { humanize } from "@cubby/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { derived } from "~/integrations/tanstack-query/generated/catalog/derived.gen";
import { RecordList, RecordRow } from "~/ui/common/record-list";

export function DerivedBacklogFooter() {
  const { data } = useQuery(derived.backlog.queryOptions({}));
  if (!data?.total) return null;
  return (
    <Link
      to="/activity"
      hash="derived-values"
      className="block px-2 py-2 text-xs text-muted-foreground hover:text-foreground"
    >
      Updating {data.total} values · Activity
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
