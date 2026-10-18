import type { AiFundingStatus } from "@cubby/schemas/mail-import-settings";
import { useState } from "react";

import { formatCurrency } from "~/lib/number-format";
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
import { Input } from "~/ui/primitives/input";

const usd = (value: number) => formatCurrency(value);
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

const PLAN_LABEL = {
  available: "available",
  paused: "paused",
  disconnected: "disconnected",
  needs_reauthorization: "needs reauthorization",
} satisfies Record<AiFundingStatus["plan"]["state"], string>;

/** Both six-hour budgets and whether the ChatGPT plan can carry work now. */
export function AiFundingSummary({ budget }: { budget: AiFundingStatus }) {
  const { credit, paid, plan } = budget;
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p className="tabular-nums">
        Claude credit {usd(credit.spentUsd)} of {usd(credit.limitUsd)} · Paid{" "}
        {usd(paid.spentUsd)} of {usd(paid.limitUsd)} · ChatGPT plan:{" "}
        {PLAN_LABEL[plan.state]}
        {plan.until ? ` until ${clock(plan.until)}` : null}
      </p>
      <p className="text-xs">
        Budgets reset {clock(budget.windowEnd)}. Background work uses Claude
        credit, then the ChatGPT plan, and otherwise waits; it never pays on its
        own.
      </p>
      {plan.state !== "available" && plan.reason ? (
        <p className="text-xs break-words">{plan.reason}</p>
      ) : null}
    </div>
  );
}

export function CreditBudgetEditor({
  limitUsd,
  pending,
  onSave,
}: {
  limitUsd: number;
  pending: boolean;
  onSave: (limitUsd: number) => void;
}) {
  const [draft, setDraft] = useState(String(limitUsd));
  const value = Number(draft);
  const valid = draft.trim() !== "" && Number.isFinite(value) && value >= 0;
  return (
    <form
      className="flex items-center gap-2 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave(value);
      }}
    >
      <label htmlFor="credit-budget" className="text-muted-foreground">
        Claude credit budget per window
      </label>
      <span className="text-muted-foreground" aria-hidden>
        $
      </span>
      <Input
        id="credit-budget"
        type="number"
        inputMode="decimal"
        min={0}
        max={100}
        step={0.5}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="h-7 w-20 tabular-nums"
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending || !valid || value === limitUsd}
      >
        Save
      </Button>
    </form>
  );
}

/**
 * The one-Run override of "background work never pays". Within the paid
 * budget one confirmation suffices; once the window's paid budget is spent a
 * second confirmation names the amount past it (one more paid budget).
 */
export function PaidRunButton({
  label,
  budget,
  pending,
  onConfirm,
}: {
  label: string;
  budget: AiFundingStatus | undefined;
  pending: boolean;
  onConfirm: (paidOverBudgetUsd: number | undefined) => void;
}) {
  const [step, setStep] = useState<"closed" | "paid" | "over">("closed");
  const paid = budget?.paid;
  const spent = paid ? paid.spentUsd >= paid.limitUsd : false;
  const overAmount = paid?.limitUsd ?? 1;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={pending || !budget}
        onClick={() => setStep("paid")}
      >
        {label}
      </Button>
      <AlertDialog
        open={step !== "closed"}
        onOpenChange={(open) => !open && setStep("closed")}
      >
        <AlertDialogContent>
          {step === "over" && paid ? (
            <AlertDialogHeader>
              <AlertDialogTitle>Spend past the paid budget?</AlertDialogTitle>
              <AlertDialogDescription>
                This window has already spent {usd(paid.spentUsd)} of{" "}
                {usd(paid.limitUsd)} on paid models. Allow this Run up to{" "}
                {usd(overAmount)} more until {clock(budget.windowEnd)}.
              </AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
            <AlertDialogHeader>
              <AlertDialogTitle>
                Allow paid models for this Run?
              </AlertDialogTitle>
              <AlertDialogDescription>
                It skips the wait for Claude credit or the ChatGPT plan and
                spends from the paid budget
                {paid
                  ? ` (${usd(paid.spentUsd)} of ${usd(paid.limitUsd)} used this window)`
                  : ""}
                .
              </AlertDialogDescription>
            </AlertDialogHeader>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {step === "over" ? (
              <AlertDialogAction
                onClick={() => {
                  setStep("closed");
                  onConfirm(overAmount);
                }}
              >
                Allow {usd(overAmount)} over budget
              </AlertDialogAction>
            ) : (
              <AlertDialogAction
                onClick={() => {
                  if (spent) {
                    setStep("over");
                    return;
                  }
                  setStep("closed");
                  onConfirm(undefined);
                }}
              >
                Allow paid models
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
