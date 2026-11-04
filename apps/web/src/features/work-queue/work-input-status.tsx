import type { WorkQueueOut } from "@cubby/schemas/work-queue";
import { countLabel } from "@cubby/shared/pluralize";

import { AttentionInputStatus } from "~/features/project/attention-input-status";

type WorkInputMeta = Pick<
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

/** Work and Home disclose the same publication gaps instead of claiming an empty inbox. */
export function WorkInputStatus({ meta }: { meta: WorkInputMeta | undefined }) {
  const sources = meta?.incompleteDiagnosticSources;
  const error = sources?.find((source) => source.error)?.error;
  return (
    <>
      <AttentionInputStatus count={meta?.incompleteProjectIds?.length ?? 0} />
      {meta?.incompleteSources?.map((source) => (
        <p key={source.source} className="text-sm text-muted-foreground">
          {source.label} have not been published for{" "}
          {countLabel(source.count, "record")}. Counts include known work only.
        </p>
      ))}
      {!!sources?.length && (
        <p className="text-sm text-muted-foreground">
          Diagnostic counts are unavailable or out of date for{" "}
          {countLabel(sources.length, "check")}. Counts include known findings
          only.
          {sources.some((source) => source.pending) && " Updates are pending."}
          {error && <span className="block font-mono">{error}</span>}
        </p>
      )}
    </>
  );
}
