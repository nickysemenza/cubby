import { useQuery } from "@tanstack/react-query";
import { createElement, useMemo } from "react";
import { ProjectMark } from "~/app/projects/project-mark";
import { useTRPC } from "~/integrations/trpc/react";

const NO_PROJECT_OPTIONS: Array<{
  value: string;
  label: string;
  icon: ReturnType<typeof createElement>;
}> = [];
const NO_PROJECT_ICONS = new Map<string, string | null>();

/**
 * Full project list as icon-bearing `{value,label}` options, name-sorted — feeds the
 * task/expense project filter select and the quick-add dialogs' project
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
        icon: createElement(ProjectMark, { icon: project.icon }),
      })) ?? NO_PROJECT_OPTIONS,
    [data],
  );
  const iconById = useMemo(
    () =>
      data
        ? new Map(data.map((project) => [project.id as string, project.icon]))
        : NO_PROJECT_ICONS,
    [data],
  );

  return { options, iconById, isLoading };
}
