import type {
  ReportCommand,
  ReportCommandRequest,
} from "@cubby/schemas/entity-report";
import { useState } from "react";
import { match } from "ts-pattern";

import { runHref } from "~/app/purchases/purchase-import-links";
import {
  problems,
  run,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { useActionMutation } from "~/ui/hooks/useActionMutation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/ui/primitives/alert-dialog";
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
  return {
    pending: control.isPending || finding.isPending || retry.isPending,
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

/** A command with a declared confirmation asks first; the rest act on the tap. */
export function CommandButton({
  command,
  commands,
}: {
  command: ReportCommand;
  commands: ReportCommands;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={command.prominent ? "default" : "outline"}
        disabled={commands.pending}
        onClick={() =>
          command.confirm === null
            ? commands.run(command.request)
            : setAsking(true)
        }
      >
        {command.label}
      </Button>
      {command.confirm === null ? null : (
        <AlertDialog open={asking} onOpenChange={setAsking}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{command.label}</AlertDialogTitle>
              <AlertDialogDescription>{command.confirm}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setAsking(false);
                  commands.run(command.request);
                }}
              >
                {command.label}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
