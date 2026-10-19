import type { AiFundingStatus } from "@cubby/schemas/mail-import-settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { aiFunding } from "~/integrations/tanstack-query/generated/catalog.gen";
import { formatCurrency } from "~/lib/number-format";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Row, Stack } from "~/ui/layout";
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
import { StaticTable } from "~/ui/primitives/static-table";
import { StatusText } from "~/ui/primitives/status-text";

const usd = (value: number) => formatCurrency(value);
const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
/** A refusal can last weeks (a Console limit names its reset date). */
const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

const PLAN_LABEL = {
  available: "available",
  paused: "paused",
  disconnected: "disconnected",
  needs_reauthorization: "needs reauthorization",
} satisfies Record<AiFundingStatus["plan"]["state"], string>;

const creditLabel = ({ credit }: AiFundingStatus) =>
  credit.state === "refused" && credit.until
    ? `refused until ${when(credit.until)}`
    : credit.spentUsd >= credit.limitUsd
      ? "budget spent"
      : "available";
const planLabel = ({ plan }: AiFundingStatus) =>
  `${PLAN_LABEL[plan.state]}${plan.until ? ` until ${when(plan.until)}` : ""}`;

/** The one-line funding summary features show, linking to Settings. */
export function AiFundingLine({ budget }: { budget: AiFundingStatus }) {
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      Claude credit {usd(budget.credit.spentUsd)} of{" "}
      {usd(budget.credit.limitUsd)}, {creditLabel(budget)} · ChatGPT plan{" "}
      {planLabel(budget)} ·{" "}
      <Link to="/settings" hash="ai-funding" className="underline">
        AI funding
      </Link>
    </p>
  );
}

type FundingRow = {
  id: string;
  source: string;
  window: string;
  state: string;
};

/**
 * Household-wide frontier AI funding (ADR 0017): both six-hour budgets, the
 * Claude credit's refusal state with Anthropic's raw reason, and the plan.
 */
export function AiFundingSettings() {
  const queryClient = useQueryClient();
  const status = useQuery(aiFunding.status.queryOptions({}));
  const replace = (data: AiFundingStatus) => {
    queryClient.setQueryData(aiFunding.status.queryOptions({}).queryKey, data);
  };
  const setCredit = useActionMutation({
    mutationFn: () => aiFunding.setCreditBudget.mutationOptions(),
    success: "Claude credit budget updated",
    error: "Couldn't update the Claude credit budget",
    onSuccess: replace,
  });
  const retry = useActionMutation({
    mutationFn: () => aiFunding.resetCreditRefusal.mutationOptions(),
    success: "Claude credit will be tried on the next call",
    error: "Couldn't clear the Claude credit refusal",
    onSuccess: replace,
  });
  const budget = status.data;
  const rows: FundingRow[] = budget
    ? [
        {
          id: "credit",
          source: "Claude credit",
          window: `${usd(budget.credit.spentUsd)} of ${usd(budget.credit.limitUsd)}`,
          state: creditLabel(budget),
        },
        {
          id: "plan",
          source: "ChatGPT plan",
          window: "Subscription",
          state: planLabel(budget),
        },
        {
          id: "paid",
          source: "Paid",
          window: `${usd(budget.paid.spentUsd)} of ${usd(budget.paid.limitUsd)}`,
          state:
            budget.paid.spentUsd >= budget.paid.limitUsd
              ? "budget spent"
              : "only where allowed",
        },
      ]
    : [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Every feature’s frontier AI calls use Claude credit first, then the
        ChatGPT plan, then paid models only where allowed. Background work waits
        for free capacity instead of paying.
      </p>
      <Stack gap="md">
        {status.isLoading ? <StatusText>Loading AI funding…</StatusText> : null}
        {status.error ? <ErrorDisplay error={status.error} /> : null}
        {budget ? (
          <>
            <Stack gap="sm">
              <StaticTable
                rows={rows}
                rowKey={(row) => row.id}
                cellClassName="tabular-nums"
                columns={[
                  {
                    id: "source",
                    header: "Funding",
                    cell: (row) => row.source,
                  },
                  {
                    id: "window",
                    header: "This window",
                    cell: (row) => row.window,
                  },
                  {
                    id: "state",
                    header: "State",
                    cell: (row) => row.state,
                  },
                ]}
              />
              <p className="text-xs text-muted-foreground">
                Budgets reset {clock(budget.windowEnd)}.
              </p>
            </Stack>
            {budget.credit.state === "refused" ? (
              <Stack gap="sm">
                <Row align="center" justify="between" gap="sm" wrap>
                  <p className="min-w-0 text-sm">
                    Anthropic refused Claude credit. Cubby skips it until{" "}
                    {budget.credit.until ? when(budget.credit.until) : "reset"},
                    trying one call each six-hour window.
                  </p>
                  <Button
                    variant="outline"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate({})}
                  >
                    Retry Claude credit now
                  </Button>
                </Row>
                {budget.credit.reason ? (
                  <code className="rounded-md bg-muted p-3 text-xs break-all">
                    {budget.credit.reason}
                  </code>
                ) : null}
              </Stack>
            ) : null}
            {budget.plan.state !== "available" && budget.plan.reason ? (
              <p className="text-xs break-words text-muted-foreground">
                ChatGPT plan: {budget.plan.reason}
              </p>
            ) : null}
            <CreditBudgetEditor
              key={budget.credit.limitUsd}
              limitUsd={budget.credit.limitUsd}
              pending={setCredit.isPending}
              onSave={(creditLimitUsd) => setCredit.mutate({ creditLimitUsd })}
            />
          </>
        ) : null}
      </Stack>
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
