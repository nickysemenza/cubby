import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { useTRPC } from "~/integrations/trpc/react";

const NO_PROJECT_OPTIONS: Array<{ value: string; label: string }> = [];

/**
 * Full project list as `{value,label}` options, name-sorted — feeds the
 * task/purchase project filter select and the quick-add dialogs' project
 * field. Projects are a small, personal household list (dozens, not
 * thousands), so one big fetch beats building a dedicated async-search
 * entity picker (no `WithProjectSearch` exists). Backed by the lightweight
 * `project.options` procedure (no rollups/dependency joins), not `list`.
 */
export function useProjectOptions() {
  const api = useTRPC();
  const { data, isLoading } = useQuery(api.project.options.queryOptions());

  const options = useMemo(
    () =>
      data?.map((project) => ({
        value: project.id as string,
        label: project.name,
      })) ?? NO_PROJECT_OPTIONS,
    [data],
  );

  return { options, isLoading };
}
