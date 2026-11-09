import type { WorkQueueOut } from "@cubby/schemas/work-queue";
import { countLabel } from "@cubby/shared/pluralize";

export type WorkInputMeta = Pick<
  WorkQueueOut["meta"],
  "incompleteProjectIds" | "incompleteDiagnosticSources" | "incompleteSources"
>;

export function hasIncompleteWorkInputs(meta: WorkInputMeta | undefined) {
  return Boolean(
    meta?.incompleteProjectIds?.length ||
    meta?.incompleteDiagnosticSources?.length ||
    meta?.incompleteSources?.length,
  );
}

/**
 * Work and Home disclose the same publication gaps instead of claiming an
 * empty inbox: one quiet line, with each incomplete check behind a disclosure.
 */
export function WorkInputStatus({ meta }: { meta: WorkInputMeta | undefined }) {
  const projects = meta?.incompleteProjectIds?.length ?? 0;
  const diagnostics = meta?.incompleteDiagnosticSources ?? [];
  const error = diagnostics.find((source) => source.error)?.error;
  const items: { key: string; label: string; extent: string }[] = [
    ...(projects
      ? [
          {
            key: "projects",
            label: "Project attention",
            extent: countLabel(projects, "project"),
          },
        ]
      : []),
    ...(meta?.incompleteSources ?? []).map((source) => ({
      key: source.source,
      label: source.label,
      extent:
        source.message ??
        (source.count === null
          ? "extent unknown"
          : countLabel(source.count, "record")),
    })),
    ...(diagnostics.length
      ? [
          {
            key: "diagnostics",
            label: "Diagnostic counts",
            extent: `${countLabel(diagnostics.length, "check")} ${
              diagnostics.some((source) => source.pending)
                ? "pending"
                : "out of date"
            }`,
          },
        ]
      : []),
  ];
  if (!items.length) return null;
  return (
    <details className="py-1 text-xs text-muted-foreground">
      <summary className="cursor-pointer">
        Counts cover known work only while {countLabel(items.length, "check")}{" "}
        {items.length === 1 ? "finishes" : "finish"} updating.
      </summary>
      <ul className="mt-1 space-y-0.5">
        {items.map((item) => (
          <li key={item.key} className="flex min-w-0 justify-between gap-3">
            <span className="min-w-0 truncate">{item.label}</span>
            <span className="shrink-0 tabular-nums">{item.extent}</span>
          </li>
        ))}
      </ul>
      {error && <p className="mt-1 font-mono break-all">{error}</p>}
    </details>
  );
}
