import { CHATGPT_USAGE_URL } from "@cubby/schemas/chatgpt";
import type {
  AiBudgetSettings,
  AiFundingStatus,
  FundingAvailability,
  FundingRefusalSource,
} from "@cubby/schemas/mail-import-settings";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useState, type ReactNode } from "react";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import { aiFunding } from "~/integrations/tanstack-query/generated/domains/aiFunding.gen";
import { formatCurrency } from "~/lib/number-format";
import { StaticTable } from "~/ui/data-table/static-table";
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
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
} from "~/ui/text/code-block";
import { Description } from "~/ui/text/description";
import { EnumPill } from "~/ui/text/enum-pill";
import { StatusText } from "~/ui/text/status-text";

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

type SourceId = "credit" | "openaiCredit" | "plan" | "paid";
type Blocker = NonNullable<FundingAvailability["blocker"]>;

const SOURCES = [
  { id: "credit", source: "Claude credit", provider: "Anthropic" },
  { id: "openaiCredit", source: "OpenAI credit", provider: "OpenAI" },
  { id: "plan", source: "ChatGPT plan", provider: "ChatGPT" },
  { id: "paid", source: "Paid", provider: "AI Gateway" },
] as const satisfies readonly {
  id: SourceId;
  source: string;
  provider: string;
}[];

/** Who recovers it: amber resets by itself, red waits for a member. */
const TONE = {
  positive: { color: "var(--positive)", Icon: CheckCircleIcon },
  warning: { color: "var(--warning)", Icon: ClockIcon },
  destructive: { color: "var(--destructive)", Icon: WarningCircleIcon },
} as const;

type Verdict = { tone: keyof typeof TONE; label: string };

/** The server's availability verdict in a few words, shared by every summary. */
function fundingVerdict(budget: AiFundingStatus, id: SourceId): Verdict {
  const { availability } = budget[id];
  const { until } = availability;
  const blocker: Blocker | null = availability.blocker;
  switch (blocker) {
    case null:
      return { tone: "positive", label: "Usable" };
    case "budget_spent":
      return {
        tone: "warning",
        label: `Budget spent · resets ${clock(until ?? budget.windowEnd)}`,
      };
    case "provider_refused":
      return {
        tone: "destructive",
        label: until ? `Refused until ${when(until)}` : "Refused by provider",
      };
    case "plan_limit":
      return until
        ? { tone: "warning", label: `Usage limit · resets ${when(until)}` }
        : { tone: "destructive", label: "Usage limit · reset time unknown" };
    case "disconnected":
      return { tone: "destructive", label: "Disconnected" };
    case "needs_reauthorization":
      return { tone: "destructive", label: "Needs reauthorization" };
    case "gateway_balance_empty":
      return { tone: "destructive", label: "Gateway balance empty" };
  }
}

/** What the member reads beside the raw refusal. */
function detailSentence(budget: AiFundingStatus, id: SourceId) {
  const { until } = budget[id].availability;
  const at = until ? when(until) : "the next window";
  if (id === "paid")
    return `The AI Gateway account has no balance, so paid models stop until ${at}, trying one call each six-hour window. Add balance in Cloudflare, then retry.`;
  if (id === "plan") return null;
  const provider = id === "credit" ? "Anthropic" : "OpenAI";
  return `${provider} refused this credit. Cubby skips it until ${at}, trying one call each six-hour window.`;
}

function FundingStatus({ verdict }: { verdict: Verdict }) {
  const { color, Icon } = TONE[verdict.tone];
  return (
    <EnumPill optionRole="status" color={color} icon={<Icon weight="fill" />}>
      {verdict.label}
    </EnumPill>
  );
}

/** The one-line funding summary features show, linking to Settings. */
export function AiFundingLine({ budget }: { budget: AiFundingStatus }) {
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {SOURCES.map(({ id, source }) => (
        <Fragment key={id}>
          {source} {usd(budget[id].spentUsd)} of {usd(budget[id].limitUsd)},{" "}
          {fundingVerdict(budget, id).label} ·{" "}
        </Fragment>
      ))}
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

/**
 * Household-wide frontier AI funding (ADR 0017): one row per source with its
 * window budget, whether background work can use it now, the raw refusal
 * behind a disclosure and the row's own recovery action.
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
    mutationFn: () => aiFunding.resetFundingRefusal.mutationOptions(),
    success: "Cubby will try it on the next call",
    error: "Couldn't clear the refusal",
    onSuccess: replace,
  });
  const budget = status.data;
  const retryButton = (source: FundingRefusalSource, label: string) => (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={retry.isPending}
      onClick={() => retry.mutate({ source })}
    >
      {label}
    </Button>
  );
  const actions = (data: AiFundingStatus) => ({
    ...(data.credit.state === "refused" && {
      credit: retryButton("credit", "Retry Claude credit now"),
    }),
    ...(data.openaiCredit.state === "refused" && {
      openaiCredit: retryButton("openaiCredit", "Retry OpenAI credit now"),
    }),
    ...(data.paid.state === "refused" && {
      paid: retryButton("paid", "Retry paid now"),
    }),
    ...(data.plan.state === "paused" && {
      plan: (
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={
            <a href={CHATGPT_USAGE_URL} target="_blank" rel="noreferrer">
              Manage usage
            </a>
          }
        />
      ),
    }),
    ...((data.plan.state === "disconnected" ||
      data.plan.state === "needs_reauthorization") && {
      plan: (
        <Button
          size="sm"
          variant="outline"
          nativeButton={false}
          render={
            <Link to="/settings" hash="chatgpt">
              {data.plan.state === "disconnected" ? "Connect" : "Reconnect"}
            </Link>
          }
        />
      ),
    }),
  });
  return (
    <div className="space-y-3">
      <Description size="xs">
        Every feature’s frontier AI calls use Claude credit first, then OpenAI
        credit, then the ChatGPT plan, then paid models. Background work stops
        drawing each free source at its window budget (the plan’s quota is
        shared with your own use), then pays within the paid budget.
      </Description>
      <Stack gap="md">
        {status.isLoading ? <StatusText>Loading AI funding…</StatusText> : null}
        {status.error ? <ErrorDisplay error={status.error} /> : null}
        {budget ? (
          <Stack gap="sm">
            <FundingBudgetEditor
              key={`${budget.credit.limitUsd}:${budget.openaiCredit.limitUsd}:${budget.plan.limitUsd}:${budget.paid.limitUsd}`}
              budget={budget}
              pending={setCredit.isPending}
              onSave={(settings) => setCredit.mutate(settings)}
              actions={actions(budget)}
            />
            <p className="text-xs text-muted-foreground">
              Budgets reset {clock(budget.windowEnd)}.
            </p>
          </Stack>
        ) : null}
      </Stack>
    </div>
  );
}

type FundingRow = (typeof SOURCES)[number] & {
  verdict: Verdict;
  reason: string | null;
};

export function FundingBudgetEditor({
  budget,
  pending,
  onSave,
  actions = {},
}: {
  budget: AiFundingStatus;
  pending: boolean;
  onSave: (settings: AiBudgetSettings) => void;
  /** Each source's recovery action, shown on its own row. */
  actions?: Partial<Record<SourceId, ReactNode>>;
}) {
  const [draft, setDraft] = useState({
    credit: String(budget.credit.limitUsd),
    openaiCredit: String(budget.openaiCredit.limitUsd),
    plan: String(budget.plan.limitUsd),
    paid: String(budget.paid.limitUsd),
  });
  const [open, setOpen] = useState<ReadonlySet<SourceId>>(new Set());
  const valid = Object.values(draft).every(
    (value) =>
      value.trim() !== "" &&
      Number.isFinite(Number(value)) &&
      Number(value) >= 0 &&
      Number(value) <= 100,
  );
  const changed =
    draft.credit !== String(budget.credit.limitUsd) ||
    draft.openaiCredit !== String(budget.openaiCredit.limitUsd) ||
    draft.plan !== String(budget.plan.limitUsd) ||
    draft.paid !== String(budget.paid.limitUsd);
  const rows: FundingRow[] = SOURCES.map((source) => ({
    ...source,
    verdict: fundingVerdict(budget, source.id),
    // A usable source keeps no stale diagnostic.
    reason: budget[source.id].availability.usable
      ? null
      : budget[source.id].reason,
  }));
  const detailId = (id: SourceId) => `ai-funding-${id}-details`;
  const toggle = (id: SourceId) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
  };
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && changed && !pending)
          onSave({
            creditLimitUsd: Number(draft.credit),
            openaiCreditLimitUsd: Number(draft.openaiCredit),
            planLimitUsd: Number(draft.plan),
            paidLimitUsd: Number(draft.paid),
          });
      }}
    >
      <StaticTable
        rows={rows}
        rowKey={(row) => row.id}
        // Phones scroll the table sideways rather than crushing its controls.
        className="min-w-3xl"
        cellClassName="tabular-nums"
        columns={[
          {
            id: "source",
            header: "Funding",
            headClassName: "w-28",
            rowHeader: true,
            cell: (row) => row.source,
          },
          {
            id: "status",
            header: "Status",
            headClassName: "w-72",
            cell: (row) => (
              <Row align="center" gap="sm">
                <FundingStatus verdict={row.verdict} />
                {row.reason ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-expanded={open.has(row.id)}
                    aria-controls={detailId(row.id)}
                    aria-label={`${row.source} details`}
                    onClick={() => toggle(row.id)}
                    className="group/details text-muted-foreground"
                    data-open={open.has(row.id) || undefined}
                  >
                    <CaretRightIcon
                      aria-hidden
                      className="transition-transform duration-(--brand-motion-fast) ease-cozy group-data-open/details:rotate-90"
                    />
                    Details
                  </Button>
                ) : null}
              </Row>
            ),
          },
          {
            id: "window",
            header: "This window",
            headClassName: "w-44",
            cell: (row) => (
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
                  className="h-7 w-20 shrink-0 tabular-nums"
                />
              </Row>
            ),
          },
          {
            id: "action",
            header: <span className="sr-only">Action</span>,
            cellClassName: "text-right",
            cell: (row) => actions[row.id] ?? null,
          },
        ]}
        rowDetail={(row) =>
          row.reason && open.has(row.id) ? (
            // Sticky and viewport-bounded: on a phone the table scrolls
            // sideways, but the diagnostic stays readable in view.
            <div
              id={detailId(row.id)}
              className="sticky left-2 max-w-[calc(100vw-3rem)] space-y-1.5 py-0.5"
            >
              {detailSentence(budget, row.id) ? (
                <p className="max-w-prose text-muted-foreground">
                  {detailSentence(budget, row.id)}
                </p>
              ) : null}
              <CodeBlock>
                <CodeBlockHeader
                  label={`${row.provider} response`}
                  value={row.reason}
                />
                <CodeBlockContent>{row.reason}</CodeBlockContent>
              </CodeBlock>
            </div>
          ) : null
        }
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
 * amount past it (between $1 and $10). A recorded empty gateway balance is
 * named before confirming; the grant clears it so the Run probes the gateway.
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
              {paid?.state === "refused" ? (
                <AlertDialogDescription className="text-destructive">
                  The AI Gateway balance was empty
                  {paid.until ? ` (held until ${clock(paid.until)})` : ""}.
                  Allowing paid models tries the gateway again now; add balance
                  first or the Run pauses again.
                </AlertDialogDescription>
              ) : null}
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
