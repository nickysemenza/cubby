import type { ReclassifyEmailsOut } from "@cubby/schemas/email-actions";
import { emailPurchaseLink } from "@cubby/schemas/email-fields";
import {
  type EmailShortcode,
  parseShortcodeFor,
} from "@cubby/schemas/identifiers";
import { EMAIL_RECLASSIFY_LIMIT } from "@cubby/schemas/mailbox-research";
import { countLabel } from "@cubby/shared/pluralize";
import { useState } from "react";
import { z } from "zod";

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

import { useRelationScope } from "../entity-detail/relation-scope";
import { useActionMutation } from "../hooks/use-action-mutation";
import { VerbMenuItem } from "./action-verb-ui";
import type {
  EntityActionHandles,
  EntityActionResolutionContext,
  EntityActionRow,
} from "./entity-actions";

/** Submission only queues work; Run receipts establish outcomes. */
export function reclassifySummary({ runIds }: ReclassifyEmailsOut) {
  return `Reclassification queued (${runIds.join(", ")}). Results will appear on the Runs.`;
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

/** The Email row fields a pair action reads; every Email list requests them. */
export const EMAIL_PAIR_READ_FIELDS = [
  "checksum",
  "ownedByViewer",
  "ledgerPartyName",
  "purchaseLinks",
] as const;

/** The Email row fields a pair action reads; the list hydrates them. */
const pairRow = z.object({
  id: z.string(),
  checksum: z.string(),
  ownedByViewer: z.boolean(),
  ledgerPartyName: z.string().nullable(),
  purchaseLinks: z.array(emailPurchaseLink),
});

/** The (Email, Purchase) pair a row stands for inside a Purchase's Emails section. */
function usePurchasePair() {
  const scope = useRelationScope();
  return (row: EntityActionRow) => {
    if (scope?.source !== "purchase") return null;
    const parsed = pairRow.safeParse(row);
    if (!parsed.success) return null;
    const link = parsed.data.purchaseLinks.find(
      (candidate) => candidate.purchaseId === scope.recordId,
    );
    return link ? { email: parsed.data, link } : null;
  };
}

type Pair = NonNullable<ReturnType<ReturnType<typeof usePurchasePair>>>;

const ownerReason = (pair: Pair) =>
  pair.email.ownedByViewer
    ? undefined
    : `${pair.email.ledgerPartyName ?? "Another member"}'s Email; only they can change its links`;

function usePairDecision(decision: "linked" | "dismissed") {
  return useActionMutation({
    mutationFn: purchaseImport.emailPurchaseDecide.mutationOptions,
    error:
      decision === "linked"
        ? "Could not link the Email"
        : "Could not dismiss the Email",
    success: ({ purchaseId }) =>
      decision === "linked"
        ? `Linked to ${purchaseId}`
        : `Dismissed for ${purchaseId}`,
  });
}

const decisionInput = (pair: Pair, decision: "linked" | "dismissed") => ({
  id: parseShortcodeFor("email", pair.email.id),
  expectedChecksum: pair.email.checksum,
  purchaseId: pair.link.purchaseId,
  decision,
});

/**
 * Link a suggested or dismissed Email to the Purchase whose section it is in.
 * Only a link that takes another Purchase's place asks first.
 */
export function useLinkEmailToPurchaseAction(): EntityActionHandles {
  const pairFor = usePurchasePair();
  const decide = usePairDecision("linked");
  const [replacing, setReplacing] = useState<Pair | null>(null);
  return {
    run: null,
    rowMenuItem: (row) => {
      const pair = pairFor(row);
      if (!pair || pair.link.state === "linked") return null;
      return (
        <VerbMenuItem
          verb="linkToPurchase"
          disabledReason={ownerReason(pair)}
          onSelect={(event) => {
            event.stopPropagation();
            if (pair.link.replacesPurchaseIds.length > 0) setReplacing(pair);
            else decide.mutate(decisionInput(pair, "linked"));
          }}
        />
      );
    },
    dialog: replacing && (
      <AlertDialog
        open
        onOpenChange={(open) => {
          if (!open) setReplacing(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Link to {replacing.link.purchaseId} instead?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This Email is linked to{" "}
              {replacing.link.replacesPurchaseIds.join(", ")} for the same order
              event. Linking it here replaces that link; spending and inventory
              do not change.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={decide.isPending}
              onClick={() => {
                decide.mutate(decisionInput(replacing, "linked"));
                setReplacing(null);
              }}
            >
              Link here
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    ),
  };
}

/** Dismiss a linked or suggested Email for the Purchase whose section it is in. */
export function useDismissEmailForPurchaseAction(): EntityActionHandles {
  const pairFor = usePurchasePair();
  const decide = usePairDecision("dismissed");
  return {
    run: null,
    rowMenuItem: (row) => {
      const pair = pairFor(row);
      if (!pair || pair.link.state === "dismissed") return null;
      return (
        <VerbMenuItem
          verb="dismissForPurchase"
          disabledReason={
            ownerReason(pair) ??
            (pair.link.accepted
              ? "Imported from this Email; correct the Purchase through reconciliation"
              : undefined)
          }
          onSelect={(event) => {
            event.stopPropagation();
            decide.mutate(decisionInput(pair, "dismissed"));
          }}
        />
      );
    },
    dialog: null,
  };
}
