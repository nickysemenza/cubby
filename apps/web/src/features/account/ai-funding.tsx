import { CHATGPT_USAGE_URL } from "@cubby/schemas/chatgpt";
import type {
  AiBudgetSettings,
  AiFundingStatus,
} from "@cubby/schemas/mail-import-settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { aiFunding } from "~/integrations/tanstack-query/domains/aiFunding";
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
  plan.state === "available" && plan.spentUsd >= plan.limitUsd
    ? "budget spent"
    : plan.state === "paused" && !plan.until
      ? "usage limit reached; ChatGPT didn’t say when it resets"
      : `${PLAN_LABEL[plan.state]}${plan.until ? ` until ${when(plan.until)}` : ""}`;

/** The one-line funding summary features show, linking to Settings. */
export function AiFundingLine({ budget }: { budget: AiFundingStatus }) {
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      Claude credit {usd(budget.credit.spentUsd)} of{" "}
      {usd(budget.credit.limitUsd)}, {creditLabel(budget)} · ChatGPT plan{" "}
      {usd(budget.plan.spentUsd)} of {usd(budget.plan.limitUsd)},{" "}
      {planLabel(budget)} ·{" "}
      <Link to="/settings" hash="ai-funding" className="underline">
        AI funding
      </Link>
    </p>
  );
}

/**
 * Background work spends credit and records refusals without touching this
 * query, so it refreshes on mount and focus and every minute while visible.
 */
export const aiFundingStatusQuery = () => ({
  ...aiFunding.status.queryOptions({}),
  refetchOnMount: true,
  refetchOnWindowFocus: true,
  refetchInterval: 60_000,
});

type FundingRow = {
  id: string;
  source: string;
  window: ReactNode;
  state: string;
};

/**
 * Household-wide frontier AI funding (ADR 0017): the three six-hour budgets,
 * the Claude credit's refusal state with Anthropic's raw reason, and the plan.
 */
export function AiFundingSettings() {
  const queryClient = useQueryClient();
  const status = useQuery(aiFundingStatusQuery());
  const replace = (data: AiFundingStatus) => {
    queryClient.setQueryData(aiFunding.status.queryOptions({}).queryKey, data);
  };
  const setCredit = useActionMutation({
    mutationFn: () => aiFunding.setCreditBudget.mutationOptions(),
    success: "AI budgets updated",
    error: "Couldn't update AI budgets",
    onSuccess: replace,
  });
  const retry = useActionMutation({
    mutationFn: () => aiFunding.resetCreditRefusal.mutationOptions(),
    success: "Claude credit will be tried on the next call",
    error: "Couldn't clear the Claude credit refusal",
    onSuccess: replace,
  });
  const budget = status.data;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Every feature’s frontier AI calls use Claude credit first, then the
        ChatGPT plan, then paid models. Background work stops drawing each free
        source at its window budget (the plan’s quota is shared with your own
        use), then pays within the paid budget.
      </p>
      <Stack gap="md">
        {status.isLoading ? <StatusText>Loading AI funding…</StatusText> : null}
        {status.error ? <ErrorDisplay error={status.error} /> : null}
        {budget ? (
          <>
            <Stack gap="sm">
              <FundingBudgetEditor
                key={`${budget.credit.limitUsd}:${budget.plan.limitUsd}:${budget.paid.limitUsd}`}
                budget={budget}
                pending={setCredit.isPending}
                onSave={(settings) => setCredit.mutate(settings)}
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
            {budget.plan.state === "paused" ? (
              <Row align="center" justify="between" gap="sm" wrap>
                <p className="text-sm">
                  {budget.plan.until
                    ? `ChatGPT plan usage limit reached; resets ${when(budget.plan.until)}`
                    : "ChatGPT plan usage limit reached; ChatGPT didn’t say when it resets"}
                </p>
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={
                    <a
                      href={CHATGPT_USAGE_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Manage usage
                    </a>
                  }
                />
              </Row>
            ) : null}
            {budget.plan.state !== "available" && budget.plan.reason ? (
              <p className="text-xs break-words text-muted-foreground">
                ChatGPT plan: {budget.plan.reason}
              </p>
            ) : null}
          </>
        ) : null}
      </Stack>
    </div>
  );
}

export function FundingBudgetEditor({
  budget,
  pending,
  onSave,
}: {
  budget: AiFundingStatus;
  pending: boolean;
  onSave: (settings: AiBudgetSettings) => void;
}) {
  const [draft, setDraft] = useState({
    credit: String(budget.credit.limitUsd),
    plan: String(budget.plan.limitUsd),
    paid: String(budget.paid.limitUsd),
  });
  const valid = Object.values(draft).every(
    (value) =>
      value.trim() !== "" &&
      Number.isFinite(Number(value)) &&
      Number(value) >= 0 &&
      Number(value) <= 100,
  );
  const changed =
    draft.credit !== String(budget.credit.limitUsd) ||
    draft.plan !== String(budget.plan.limitUsd) ||
    draft.paid !== String(budget.paid.limitUsd);
  const rows: FundingRow[] = (
    [
      { id: "credit", source: "Claude credit", state: creditLabel(budget) },
      { id: "plan", source: "ChatGPT plan", state: planLabel(budget) },
      {
        id: "paid",
        source: "Paid",
        state:
          budget.paid.spentUsd >= budget.paid.limitUsd
            ? "budget spent"
            : "within budget",
      },
    ] satisfies { id: keyof typeof draft; source: string; state: string }[]
  ).map((row) => ({
    ...row,
    window: (
      <Row align="center" gap="sm">
        <span>{usd(budget[row.id].spentUsd)} of $</span>
        <Input
          aria-label={`${row.source} budget per window`}
          type="number"
          inputMode="decimal"
          min={0}
          max={100}
          step={0.5}
          value={draft[row.id]}
          disabled={pending}
          onChange={(event) =>
            setDraft({ ...draft, [row.id]: event.target.value })
          }
          className="h-7 w-20 tabular-nums"
        />
      </Row>
    ),
  }));
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && changed && !pending)
          onSave({
            creditLimitUsd: Number(draft.credit),
            planLimitUsd: Number(draft.plan),
            paidLimitUsd: Number(draft.paid),
          });
      }}
    >
      <StaticTable
        rows={rows}
        rowKey={(row) => row.id}
        cellClassName="tabular-nums"
        columns={[
          { id: "source", header: "Funding", cell: (row) => row.source },
          { id: "window", header: "This window", cell: (row) => row.window },
          { id: "state", header: "State", cell: (row) => row.state },
        ]}
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        disabled={pending || !valid || !changed}
      >
        Save budgets
      </Button>
    </form>
  );
}

/**
 * The one-Run paid grant. Within the paid budget one confirmation resumes the
 * Run; once the window's paid budget is spent a second confirmation names the
 * amount past it (between $1 and $10).
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
  // One-Run grants must stay positive and within the command’s $10 cap.
  const overAmount = Math.min(10, Math.max(1, paid?.limitUsd ?? 1));
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
                It resumes now and spends from the paid budget
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
