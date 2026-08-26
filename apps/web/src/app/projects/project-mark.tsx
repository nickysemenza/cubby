import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { EntityIcon } from "~/entities/entities";
import { cn } from "~/lib/utils";
import { project } from "./project.functions";

const markClasses = {
  12: "size-3 text-xs",
  14: "size-3.5 text-sm",
  20: "size-5 text-xl",
} as const;

export type ProjectMarkSize = keyof typeof markClasses;

/** A configured project emoji, or the House-domain project glyph. */
export function ProjectMark({
  icon,
  size = 14,
  className,
}: {
  icon: string | null | undefined;
  size?: ProjectMarkSize;
  className?: string;
}) {
  if (icon) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex shrink-0 items-center justify-center overflow-hidden leading-none",
          markClasses[size],
          className,
        )}
      >
        {icon}
      </span>
    );
  }

  return (
    <EntityIcon
      entity="project"
      size={size}
      colored
      aria-hidden="true"
      className={cn("shrink-0", className)}
    />
  );
}

/**
 * Resolves relation-only links through the lightweight options query. React
 * Query deduplicates the request across every project link on the page;
 * explicit icon values skip the lookup.
 */
export function ProjectMarkById({
  projectId,
  icon,
  size = 14,
  className,
}: {
  projectId: string;
  /** `undefined` means not loaded; `null` means known-empty. */
  icon?: string | null;
  size?: ProjectMarkSize;
  className?: string;
}) {
  const { data } = useQuery({
    ...project.options.queryOptions(),
    enabled: icon === undefined,
  });
  const resolvedIcon = useMemo(
    () =>
      icon === undefined
        ? (data?.find((project) => project.id === projectId)?.icon ?? null)
        : icon,
    [data, icon, projectId],
  );

  return <ProjectMark icon={resolvedIcon} size={size} className={className} />;
}

export type ProjectChartIdentity = {
  name: string;
  icon: string | null | undefined;
};

/** Shared HTML label for chart tooltips and other visualization chrome. */
export function ProjectChartLabel({
  identity,
}: {
  identity: ProjectChartIdentity;
}) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <ProjectMark icon={identity.icon} size={12} />
      <span className="truncate">{identity.name}</span>
    </span>
  );
}

/**
 * Nivo's left axis is SVG, so a small foreignObject lets the same HTML mark
 * render beside a truncated project name instead of falling back to text-only
 * ticks. The surrounding chart owns the identity map and performs one lookup
 * per tick.
 */
export function ProjectChartTick({
  x,
  y,
  value,
  identityById,
  width = 160,
}: {
  x: number;
  y: number;
  value: string | number;
  identityById: ReadonlyMap<string, ProjectChartIdentity>;
  width?: number;
}) {
  const identity = identityById.get(String(value));
  if (!identity) return <g transform={`translate(${x}, ${y})`} />;

  return (
    <g transform={`translate(${x}, ${y})`}>
      <foreignObject x={-width} y={-10} width={width - 4} height={20}>
        <div
          className="flex h-5 items-center justify-end gap-1 overflow-hidden pr-1 text-foreground text-xs"
          title={identity.name}
        >
          <ProjectMark icon={identity.icon} size={12} />
          <span className="truncate">{identity.name}</span>
        </div>
      </foreignObject>
    </g>
  );
}
