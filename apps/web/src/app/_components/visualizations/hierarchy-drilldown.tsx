import type { LocationShortcode } from "@cubby/schemas/identifiers";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { cn } from "~/lib/utils";

/**
 * A display-ready node in a drillable hierarchy. Adapters own aggregation and
 * formatting; this component only owns navigation, sorting, and rendering.
 */
export interface HierarchyDrilldownNode {
  /** Stable across renders and unique within this hierarchy. */
  id: string;
  label: string;
  /** Human-readable total, such as `34 each` or `12 items`. */
  metricLabel: string;
  /** A comparable metric for bars, or null when values cannot be compared. */
  metricValue: number | null;
  /** The focused node's direct contribution; renders as “Directly here”. */
  directMetricLabel?: string;
  directMetricValue?: number | null;
  /** Enables a leaf link to this real location. */
  locationShortcode?: LocationShortcode;
  /** Short supporting labels, for example `installed`. */
  annotations?: readonly string[];
  children?: readonly HierarchyDrilldownNode[];
}

export interface HierarchyDrilldownProps {
  root: HierarchyDrilldownNode;
  /** Names this navigation region for assistive technology. */
  ariaLabel: string;
  className?: string;
}

interface DrilldownRow {
  id: string;
  label: string;
  metricLabel: string;
  metricValue: number | null;
  annotations?: readonly string[];
  node?: HierarchyDrilldownNode;
}

function sortedRows(node: HierarchyDrilldownNode): DrilldownRow[] {
  const rows: DrilldownRow[] = (node.children ?? []).map((child) => ({
    id: child.id,
    label: child.label,
    metricLabel: child.metricLabel,
    metricValue: child.metricValue,
    annotations: child.annotations,
    node: child,
  }));

  if (node.directMetricLabel !== undefined) {
    rows.push({
      id: `${node.id}-direct`,
      label: "Directly here",
      metricLabel: node.directMetricLabel,
      metricValue: node.directMetricValue ?? null,
    });
  }

  return rows.sort((a, b) => {
    if (a.metricValue !== null && b.metricValue !== null) {
      const byMetric = b.metricValue - a.metricValue;
      if (byMetric !== 0) return byMetric;
    } else if (a.metricValue !== null) {
      return -1;
    } else if (b.metricValue !== null) {
      return 1;
    }
    return a.label.localeCompare(b.label);
  });
}

function RowAnnotations({ annotations }: { annotations?: readonly string[] }) {
  if (!annotations?.length) return null;
  return (
    <span className="font-mono text-2xs text-muted-foreground uppercase tracking-wider">
      {annotations.join(" · ")}
    </span>
  );
}

/**
 * Flat, local-state navigation for already-normalized hierarchy data.
 * Callers retain ownership of loading, errors, aggregation, and formatting.
 */
export function HierarchyDrilldown({
  root,
  ariaLabel,
  className,
}: HierarchyDrilldownProps) {
  // Store identity, not node snapshots: query invalidation can replace the
  // tree while the user is drilled in. Re-resolving ids against `root` keeps
  // totals and labels live, and naturally falls back to the nearest surviving
  // ancestor if a move removes the focused branch.
  const [pathIds, setPathIds] = useState<readonly string[]>([]);
  const path = useMemo(() => {
    const resolved = [root];
    let current = root;
    for (const id of pathIds) {
      const next = current.children?.find((child) => child.id === id);
      if (!next) break;
      resolved.push(next);
      current = next;
    }
    return resolved;
  }, [root, pathIds]);
  const focused = path[path.length - 1] ?? root;
  const rows = useMemo(() => sortedRows(focused), [focused]);
  const canUseBars =
    rows.length > 0 && rows.every((row) => row.metricValue !== null);
  const maxMetric = canUseBars
    ? Math.max(0, ...rows.map((row) => row.metricValue ?? 0))
    : 0;

  return (
    <section
      aria-label={ariaLabel}
      className={cn("border-border border-y bg-card font-sans", className)}
    >
      <div className="border-border border-b px-2 py-2 sm:px-4">
        <div className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1">
          {path.length > 1 && (
            <button
              type="button"
              onClick={() =>
                setPathIds(path.slice(1, -1).map((node) => node.id))
              }
              className="min-h-10 shrink-0 px-2 font-medium text-primary text-xs underline-offset-4 transition-colors duration-100 ease-cozy hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px] motion-reduce:transition-none"
            >
              Back
            </button>
          )}
          <nav aria-label={`${ariaLabel} path`} className="min-w-0">
            <ol className="flex min-h-10 flex-wrap items-center gap-1 text-xs">
              {path.map((node, index) => {
                const isCurrent = index === path.length - 1;
                return (
                  <li key={node.id} className="flex min-w-0 items-center gap-1">
                    {index > 0 && (
                      <span
                        aria-hidden="true"
                        className="text-muted-foreground"
                      >
                        /
                      </span>
                    )}
                    {isCurrent ? (
                      <span
                        aria-current="page"
                        className="truncate font-semibold text-foreground"
                      >
                        {node.label}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() =>
                          setPathIds(
                            path.slice(1, index + 1).map((item) => item.id),
                          )
                        }
                        className="min-h-10 max-w-40 truncate px-1 text-primary underline-offset-4 transition-colors duration-100 ease-cozy hover:bg-muted hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px] motion-reduce:transition-none"
                      >
                        {node.label}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </nav>
          <span className="ml-auto shrink-0 font-mono text-foreground text-xs tabular-nums">
            {focused.metricLabel}
          </span>
        </div>
        <RowAnnotations annotations={focused.annotations} />
      </div>

      {rows.length > 0 ? (
        <ul
          aria-label={`${focused.label} breakdown`}
          className="divide-y divide-border"
        >
          {rows.map((row) => {
            const hasChildren = (row.node?.children?.length ?? 0) > 0;
            const barWidth =
              canUseBars && maxMetric > 0
                ? `${Math.max(0, ((row.metricValue ?? 0) / maxMetric) * 100)}%`
                : undefined;
            const metricDescription = `${row.label}: ${row.metricLabel}${row.annotations?.length ? `, ${row.annotations.join(", ")}` : ""}`;

            return (
              <li
                key={row.id}
                className="group relative min-h-11 bg-card hover:bg-muted"
              >
                {barWidth && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 bg-foreground/10 transition-[width] duration-100 ease-cozy motion-reduce:transition-none"
                    style={{ width: barWidth }}
                  />
                )}
                <div className="relative flex min-h-11 items-center gap-2 px-2 py-2 sm:px-4">
                  {hasChildren ? (
                    <button
                      type="button"
                      onClick={() =>
                        setPathIds([
                          ...path.slice(1).map((item) => item.id),
                          row.node!.id,
                        ])
                      }
                      aria-label={`Drill into ${metricDescription}`}
                      className="min-h-11 min-w-0 flex-1 px-1 text-left font-medium text-primary text-xs underline-offset-4 transition-colors duration-100 ease-cozy hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px] motion-reduce:transition-none"
                    >
                      <span className="block truncate">{row.label}</span>
                      <RowAnnotations annotations={row.annotations} />
                    </button>
                  ) : row.node?.locationShortcode ? (
                    <Link
                      to="/locations/$shortcode"
                      params={{ shortcode: row.node.locationShortcode }}
                      aria-label={`Open location ${metricDescription}`}
                      className="min-h-11 min-w-0 flex-1 px-1 py-2 font-medium text-primary text-xs underline-offset-4 transition-colors duration-100 ease-cozy hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-[-2px] motion-reduce:transition-none"
                    >
                      <span className="block truncate">{row.label}</span>
                      <RowAnnotations annotations={row.annotations} />
                    </Link>
                  ) : (
                    <span className="min-w-0 flex-1 px-1 font-medium text-foreground text-xs">
                      <span className="block truncate">{row.label}</span>
                      <RowAnnotations annotations={row.annotations} />
                    </span>
                  )}
                  <output
                    aria-label={metricDescription}
                    className="shrink-0 font-mono text-foreground text-xs tabular-nums"
                  >
                    {row.metricLabel}
                  </output>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex min-h-11 items-center justify-between px-2 py-2 sm:px-4">
          <span className="text-muted-foreground text-xs">Directly here</span>
          <output
            aria-label={`Directly here: ${focused.metricLabel}`}
            className="font-mono text-foreground text-xs tabular-nums"
          >
            {focused.metricLabel}
          </output>
        </div>
      )}
    </section>
  );
}
