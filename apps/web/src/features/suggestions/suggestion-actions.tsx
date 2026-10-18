import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { SuggestionListRow } from "@cubby/schemas/suggestion-list";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { formatCurrency } from "~/lib/number-format";
import type { CubbyRow } from "~/ui/data-table/table-features";
import { Button } from "~/ui/primitives/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubmenu,
  DropdownMenuSubmenuContent,
  DropdownMenuSubmenuTrigger,
  DropdownMenuTrigger,
} from "~/ui/primitives/dropdown-menu";

import {
  acceptItem,
  dismissItem,
  neverSuggestItem,
  offers,
  statementApplyItem,
  wrongItem,
} from "./suggestion-review";
import { useSuggestionReview } from "./suggestion-review-context";

const stop = (event: { stopPropagation: () => void }) =>
  event.stopPropagation();

/** The row's disclosure for its inline evidence (→ on the keyboard). */
export function ExpandCell({ row }: { row: CubbyRow<SuggestionListRow> }) {
  const { isOpen, toggleOpen } = useSuggestionReview();
  const open = isOpen(row.id);
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? "Hide evidence" : "Show evidence"}
      onClick={(event) => {
        stop(event);
        toggleOpen(row.id);
      }}
      className="relative inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none after:absolute after:-inset-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {open ? (
        <CaretDownIcon aria-hidden className="size-3.5" />
      ) : (
        <CaretRightIcon aria-hidden className="size-3.5" />
      )}
    </button>
  );
}

/**
 * The phone card's evidence disclosure: the desktop caret column has no phone
 * projection, so the card footer owns this 44px toggle and the evidence below.
 */
export function MobileEvidenceDisclosure({
  row,
  children,
}: {
  row: SuggestionListRow;
  children: ReactNode;
}) {
  const { isOpen, toggleOpen } = useSuggestionReview();
  const open = isOpen(row.id);
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <Button
        size="sm"
        variant="ghost"
        aria-expanded={open}
        className="min-h-11 self-start text-muted-foreground"
        onClick={(event) => {
          stop(event);
          toggleOpen(row.id);
        }}
      >
        {open ? (
          <CaretDownIcon aria-hidden className="size-3.5" />
        ) : (
          <CaretRightIcon aria-hidden className="size-3.5" />
        )}
        {open ? "Hide evidence" : "Show evidence"}
      </Button>
      {open ? children : null}
    </div>
  );
}

/** One row's review: its leading verb, Dismiss, and the family's alternatives. */
export function SuggestionActionsCell({
  row,
}: {
  row: CubbyRow<SuggestionListRow>;
}) {
  const suggestion = row.original;
  const { review, outcome, statementChoice, draft, toggleOpen } =
    useSuggestionReview();
  const state = outcome(suggestion.id);
  const busy = state?.state === "pending";
  const run = (build: Parameters<typeof review>[1]) =>
    void review([suggestion], build);

  if (
    offers(suggestion, "open_workbench") &&
    suggestion.family === "recommendation"
  ) {
    const proposal = suggestion.evidence;
    return (
      <div className="flex items-center justify-end gap-1">
        <Button
          size="xs"
          variant="outline"
          render={
            <Link
              to="/recommendations/workbench"
              search={{
                kind: "product-match",
                source: parseShortcodeFor("product", proposal.source.entityId),
                candidate: parseShortcodeFor(
                  "product",
                  proposal.target.entityId,
                ),
              }}
            />
          }
          nativeButton={false}
        >
          Open Workbench
        </Button>
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => run(dismissItem)}
        >
          Dismiss
        </Button>
      </div>
    );
  }

  const acceptOwnerOnly = suggestion.actions.some(
    (action) => action.verb === "accept" && action.ownerOnly,
  );
  const statement =
    suggestion.family === "statement_transaction" ? suggestion.evidence : null;
  const rowDraft = draft(suggestion.id);
  const wrong = wrongItem(suggestion);
  const never =
    suggestion.family === "recommendation"
      ? neverSuggestItem(suggestion)
      : null;
  const alternatives = statement
    ? statement.candidates.filter(
        (_, index) => statement.recommended !== "attach" || index > 0,
      )
    : [];
  const hasMenu =
    wrong !== null ||
    never !== null ||
    (statement !== null &&
      (statement.create !== null ||
        alternatives.length > 0 ||
        statement.candidates.some((candidate) => candidate.diff.length > 0)));

  return (
    <div className="flex min-w-0 items-center justify-end gap-1">
      {state?.state === "failed" ? (
        <span
          role="alert"
          className="min-w-0 truncate text-xs text-destructive"
          title={state.error}
        >
          {state.error}
        </span>
      ) : null}
      {offers(suggestion, "accept") ? (
        <Button
          size="xs"
          disabled={busy}
          aria-description={
            acceptOwnerOnly ? "Only the record's owner can confirm" : undefined
          }
          onClick={() =>
            run((target) => acceptItem(target, statementChoice(target)))
          }
        >
          {suggestion.family === "recommendation" ? "Confirm" : "Accept"}
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() => run(dismissItem)}
      >
        Dismiss
      </Button>
      {hasMenu ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="More review choices"
              />
            }
          >
            <DotsThreeIcon aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuGroup>
              {statement?.create ? (
                // The kind is a value: its Picker lives in the evidence.
                <DropdownMenuItem
                  onClick={() => toggleOpen(suggestion.id, true)}
                >
                  Change kind…
                </DropdownMenuItem>
              ) : null}
              {statement && alternatives.length ? (
                <DropdownMenuSubmenu>
                  <DropdownMenuSubmenuTrigger>
                    Choose another candidate
                    <CaretRightIcon className="ml-auto" />
                  </DropdownMenuSubmenuTrigger>
                  <DropdownMenuSubmenuContent>
                    {alternatives.map((candidate) => (
                      <DropdownMenuItem
                        key={candidate.transactionId}
                        onClick={() =>
                          run(() =>
                            statementApplyItem(statement, {
                              action: "attach",
                              transactionId: candidate.transactionId,
                              fields: [
                                ...(rowDraft.fields[candidate.transactionId] ??
                                  []),
                              ],
                            }),
                          )
                        }
                      >
                        Attach to{" "}
                        {candidate.merchant ??
                          candidate.rawDescription ??
                          "transaction"}{" "}
                        · {formatCurrency(candidate.amount)}
                        {(candidate.postedDate ?? candidate.transactionDate)
                          ? ` · ${candidate.postedDate ?? candidate.transactionDate}`
                          : ""}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubmenuContent>
                </DropdownMenuSubmenu>
              ) : null}
              {statement?.candidates.some(
                (candidate) => candidate.diff.length > 0,
              ) ? (
                <DropdownMenuItem
                  onClick={() => toggleOpen(suggestion.id, true)}
                >
                  Apply statement fields…
                </DropdownMenuItem>
              ) : null}
              {statement?.create &&
              statement.recommended !== "create" &&
              statement.candidates.length ? (
                <DropdownMenuItem
                  onClick={() =>
                    run(() =>
                      statementApplyItem(statement, {
                        action: "create",
                        kindOverride: rowDraft.kind,
                      }),
                    )
                  }
                >
                  Create anyway
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            {statement && (wrong || never) ? <DropdownMenuSeparator /> : null}
            <DropdownMenuGroup>
              {wrong ? (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => run(wrongItem)}
                >
                  Wrong
                </DropdownMenuItem>
              ) : null}
              {never ? (
                <DropdownMenuItem onClick={() => run(neverSuggestItem)}>
                  Never suggest this
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}
