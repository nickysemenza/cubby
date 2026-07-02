import { Link } from "@tanstack/react-router";
import { Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { formatCurrency } from "~/lib/utils";
import type { NotionProject } from "~/server/clients/notion";
import { formatDateRange, StatusIcon } from "./shared";

/**
 * A compact linked pill showing a project's name + status icon.
 * Hovering reveals a tooltip with date range, kind, location, and cost estimate.
 */
export function ProjectPill({ project }: { project: NotionProject }) {
  return (
    <Link
      to="/projects/$id"
      params={{ id: project.id }}
      className="group/pill relative inline-block"
    >
      <Badge variant="outline" className="cursor-pointer gap-1 hover:bg-muted">
        <StatusIcon status={project.status} />
        {project.icon && <span>{project.icon}</span>}
        <span className="max-w-[150px] truncate">{project.name}</span>
      </Badge>
      <ProjectTooltip project={project} />
    </Link>
  );
}

function ProjectTooltip({ project }: { project: NotionProject }) {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 opacity-0 transition-opacity group-hover/pill:opacity-100">
      <div className="whitespace-nowrap rounded-md bg-popover px-4 py-2 text-xs ring-1 ring-border">
        <div className="font-medium">
          {project.icon && `${project.icon} `}
          {project.name}
        </div>
        <Stack gap="xs" className="mt-1 text-muted-foreground">
          {project.status && <div>Status: {project.status}</div>}
          {(project.date || project.dateEnd) && (
            <div>{formatDateRange(project.date, project.dateEnd)}</div>
          )}
          {project.kind && <div>Kind: {project.kind}</div>}
          {project.location.length > 0 && (
            <div>Location: {project.location.join(", ")}</div>
          )}
          {project.costEstimate != null && (
            <div>Estimate: {formatCurrency(project.costEstimate, 0)}</div>
          )}
        </Stack>
      </div>
    </div>
  );
}
