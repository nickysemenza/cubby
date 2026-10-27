import { countLabel } from "@cubby/shared/pluralize";

/** One completeness notice for consumers of the shared attention report. */
export function AttentionInputStatus({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <p className="text-sm text-muted-foreground">
      Project attention checks are incomplete for {countLabel(count, "project")}{" "}
      while derived inputs update. Counts include known findings only.
    </p>
  );
}
