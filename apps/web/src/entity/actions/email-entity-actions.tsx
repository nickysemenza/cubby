import type { ReclassifyEmailsOut } from "@cubby/schemas/email-actions";
import {
  type EmailShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { EMAIL_RECLASSIFY_LIMIT } from "@cubby/schemas/mailbox-research";
import { countLabel } from "@cubby/shared/pluralize";
import { useState } from "react";

import { purchaseImport } from "~/integrations/tanstack-query/generated/catalog.gen";
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

import { useActionMutation } from "../../ui/hooks/useActionMutation";
import type {
  EntityActionHandles,
  EntityActionResolutionContext,
} from "./entity-actions";

/** "Reclassified: 2 replaced, 1 confirmed (RUN-…)": the outcome counts and the Run(s) holding the history. */
export function reclassifySummary({ runIds, results }: ReclassifyEmailsOut) {
  const counts = new Map<string, number>();
  for (const { outcome } of results)
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
  const outcomes = [...counts]
    .map(([outcome, count]) => `${count} ${outcome.replaceAll("_", " ")}`)
    .join(", ");
  // Failures keep their raw diagnostics (README tenets: errors are never masked).
  const errors = results.flatMap(({ id, error }) =>
    error ? [`${id}: ${error}`] : [],
  );
  return `Reclassified: ${outcomes || "nothing"}${runIds.length > 0 ? ` (${runIds.join(", ")})` : ""}${errors.length > 0 ? `. ${errors.join("; ")}` : ""}`;
}

/**
 * Over the limit stays visible with its reason rather than hiding, which a
 * `maxSelection` would do; the operation enforces the same limit.
 */
export const reclassifyEmailsAvailability = ({
  rows,
}: EntityActionResolutionContext) =>
  rows.length > EMAIL_RECLASSIFY_LIMIT
    ? ({
        status: "disabled",
        reason: `Reclassify at most ${EMAIL_RECLASSIFY_LIMIT} Emails at a time`,
      } as const)
    : ({ status: "available" } as const);

export function useReclassifyEmailsAction(): EntityActionHandles {
  const [ids, setIds] = useState<EmailShortcode[]>([]);
  const reclassify = useActionMutation({
    mutationFn: purchaseImport.emailReclassify.mutationOptions,
    error: "Could not reclassify the selected Emails",
    success: reclassifySummary,
  });
  const close = () => setIds([]);
  return {
    run: async (rows) => {
      if (rows.length > EMAIL_RECLASSIFY_LIMIT) return { success: false };
      setIds(rows.map((row) => parseShortcodeFor("email", row.id)));
      return { success: true };
    },
    rowMenuItem: () => null,
    dialog: ids.length > 0 && (
      <AlertDialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reclassify {countLabel(ids.length, "Email")}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Reruns Relevance with the current classifier. A changed result
              replaces Relevance only where nothing depends on the old one;
              every rerun is recorded on a Run.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={reclassify.isPending}
              onClick={() => {
                reclassify.mutate({ ids });
                close();
              }}
            >
              Reclassify
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}
