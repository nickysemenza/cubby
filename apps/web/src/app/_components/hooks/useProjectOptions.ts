import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTRPC } from "~/integrations/trpc/react";

const NO_PROJECT_OPTIONS: Array<{ value: string; label: string }> = [];

/**
 * Full project list as `{value,label}` options, name-sorted — feeds the
 * task/purchase project filter select and the quick-add dialogs' project
 * field. Projects are a small, personal household list (dozens, not
 * thousands), so one big-pageSize fetch beats building a dedicated
 * async-search entity picker (no `WithProjectSearch` exists).
 */
export function useProjectOptions() {
  const api = useTRPC();
  const { data, isLoading } = useQuery(
    api.project.list.queryOptions({
      filters: {},
      sort: { orderBy: "name", direction: "asc" },
      pagination: { pageIndex: 0, pageSize: 500 },
    }),
  );

  const options = useMemo(
    () =>
      data?.items.map((project) => ({
        value: project.id as string,
        label: project.name,
      })) ?? NO_PROJECT_OPTIONS,
    [data],
  );

  return { options, isLoading };
}
