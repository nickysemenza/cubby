import type {
  CommitPreparedRequest,
  ReportCommand,
  ReportCommandRequest,
} from "@cubby/schemas/entity-report";
import {
  type ChoiceAnswers,
  commitPreparedInput,
} from "@cubby/schemas/report-choice";
import { match } from "ts-pattern";

import { runHref } from "~/app/purchases/purchase-import-links";
import {
  problems,
  run,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import { Button } from "~/ui/primitives/button";

/** Runs a row command through the operation it names; the server composed the exact body. */
export function useReportCommands() {
  const control = useActionMutation({
    mutationFn: run.control.mutationOptions,
    error: "Could not update the Run",
    onSuccess: ({ successor }) => {
      if (successor) window.location.assign(runHref(successor.publicId));
    },
  });
  const finding = useActionMutation({
    mutationFn: problems.resolveRunFinding.mutationOptions,
    error: "Could not resolve the finding",
    success: (result) =>
      result.status === "applied"
        ? "Applied import correction"
        : "Dismissed import finding",
  });
  const retry = useActionMutation({
    mutationFn: run.retryGmailSearch.mutationOptions,
    error: "Could not resend Gmail work",
  });
  const commit = useActionMutation({
    mutationFn: run.commitPrepared.mutationOptions,
    error: "Could not import the prepared orders",
  });
  return {
    pending:
      control.isPending ||
      finding.isPending ||
      retry.isPending ||
      commit.isPending,
    committed: commit.isSuccess,
    /** Approves a prepared batch with the answers given; nothing is sent while any is missing. */
    commit: (
      request: CommitPreparedRequest,
      answers: ChoiceAnswers,
      operationId: string,
    ) => {
      const input = commitPreparedInput(request, answers, operationId);
      if (input) commit.mutate(input);
    },
    run: (request: ReportCommandRequest) =>
      match(request)
        .with({ kind: "run-control" }, (r) => {
          const input: Parameters<typeof run.control.call>[0] = {
            runId: r.runId,
            action: r.action,
          };
          if (r.operationId) input.operationId = r.operationId;
          if (r.approvalId) input.approvalId = r.approvalId;
          control.mutate(input);
        })
        .with({ kind: "resolve-finding" }, (r) => {
          const input: Parameters<typeof problems.resolveRunFinding.call>[0] = {
            id: r.findingId,
            action: r.decision,
          };
          if (r.reviewedFingerprint)
            input.reviewedFingerprint = r.reviewedFingerprint;
          finding.mutate(input);
        })
        .with({ kind: "retry-gmail-search" }, (r) =>
          retry.mutate({ shortcode: r.runId }),
        )
        .exhaustive(),
  };
}

export type ReportCommands = ReturnType<typeof useReportCommands>;

/**
 * A row command. Web acts on the tap, as these controls always have (the Run page's Approve,
 * Reject and Apply fix buttons never asked first); the `confirm` copy is for native, which asks
 * before anything that writes.
 */
export function CommandButton({
  command,
  commands,
}: {
  command: ReportCommand;
  commands: ReportCommands;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={command.prominent ? "default" : "outline"}
      disabled={commands.pending}
      onClick={() => commands.run(command.request)}
    >
      {command.label}
    </Button>
  );
}
