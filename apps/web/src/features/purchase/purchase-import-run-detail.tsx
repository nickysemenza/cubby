import {
  agentConversationSchema,
  agentPromptSchema,
  type AgentConversation,
  type AgentConversationMessage,
  type AgentModelUsage,
} from "@cubby/schemas/agent-conversation";
import type { ReportRowState } from "@cubby/schemas/entity-report";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import type { RunOut } from "@cubby/schemas/run";
import { runInputsErased } from "@cubby/schemas/run-fields";
import { humanize } from "@cubby/shared";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import type { RunDetail } from "~/contracts/run.contract";
import { DetailAction } from "~/entity/entity-detail/detail-action-bar";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { runHref } from "~/entity/routing/purchase-import-links";
import {
  agentUrl,
  runHasAgent,
  useAgentObservation,
  useAgentReviewSync,
  type AgentConversationObservationSnapshot,
} from "~/features/run/agent-observation";
import { AgentTranscript } from "~/features/run/agent-transcript";
import { usePhotoRunReview } from "~/features/run/photo-group-review";
import {
  PhotoImportRunView,
  PhotoRunGroupingAction,
} from "~/features/run/photo-run-detail";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  aiFunding,
  run as runOperations,
} from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { AiCost } from "~/ui/common/ai-cost";
import {
  RecordDetail,
  RecordDot,
  RecordList,
  RecordRow,
} from "~/ui/common/record-list";
import { useSectionEmpty } from "~/ui/data-table/detail-section-state";
import { Panel, Row, Section, Stack } from "~/ui/layout";
import { Disclosure } from "~/ui/layout/disclosure";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";

import { PaidRunButton } from "../account/ai-funding";
import {
  AgentContextPerCall,
  AgentTokenAccounting,
} from "./agent-context-breakdown";
import {
  formatWorkDuration,
  plannedPhotoWorkSteps,
  summarizeAgentWork,
  summarizePhotoDescriptions,
  type AgentWorkItem,
} from "./agent-work-summary";

const ACTIVE_STATUSES = new Set<string>(ACTIVE_RUN_STATUSES);

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "needs_review",
  "dispatch_failed",
]);

const EMPTY_AGENT_SNAPSHOT: AgentConversationObservationSnapshot = {
  phase: "connecting",
};

type RunControlInput = Parameters<typeof runOperations.control.call>[0];

interface RunAction {
  action: RunControlInput["action"];
  label: string;
  variant?: "outline";
  disabled?: boolean;
}

/**
 * Every control this run's state offers, in one list: stop, dispatch recovery
 * for a run the agent never picked up, and the terminal retries.
 */
function runActions(run: RunDetail): RunAction[] {
  const actions: RunAction[] = [];
  if (ACTIVE_STATUSES.has(run.status))
    actions.push({ action: "cancel", label: "Stop run", variant: "outline" });
  const { dispatch } = run;
  if (!dispatch.coordinatorStartedAt && dispatch.state !== "started")
    actions.push(
      { action: "retry_dispatch", label: "Retry dispatch" },
      { action: "abort", label: "Abort", variant: "outline" },
    );
  if (
    TERMINAL_RUN_STATUSES.has(run.status) &&
    agentImportRunPurpose.safeParse(run.purpose).success &&
    // An erased Run has no inputs or targets left to retry or copy.
    !runInputsErased(run.retirementReason)
  ) {
    if (
      run.purpose !== "photo_inventory" &&
      !run.successorRunPublicId &&
      run.status !== "dispatch_failed"
    )
      actions.push({
        action: "retry",
        label: "Retry unresolved work",
        variant: "outline",
      });
    actions.push({
      action: "restart",
      label: run.successorRunPublicId
        ? "Start another run with same inputs"
        : "Start new run with same inputs",
    });
  }
  return actions;
}

/** One control mutation; a retry that creates a successor run opens it. */
function RunActionButtons({
  runId,
  actions,
  children,
}: {
  runId: RunDetail["publicId"];
  actions: readonly RunAction[];
  children?: ReactNode;
}) {
  const control = useMutation(
    runOperations.control.mutationOptions({
      onSuccess: ({ successor }) => {
        if (successor) window.location.assign(runHref(successor.publicId));
      },
    }),
  );
  if (!actions.length) return null;
  return (
    <Stack gap="sm" className="items-end">
      <Row wrap gap="sm" justify="end">
        {actions.map((item) => (
          <Button
            key={item.action}
            type="button"
            size="sm"
            variant={item.variant}
            disabled={control.isPending || item.disabled}
            onClick={() => control.mutate({ runId, action: item.action })}
          >
            {item.label}
          </Button>
        ))}
      </Row>
      {children}
      {control.isError ? (
        <StatusText tone="destructive">{control.error.message}</StatusText>
      ) : null}
    </Stack>
  );
}

/** Paused by a funding stop (`pauseExecutionRun`): waiting for free capacity or the paid budget. */
const waitsForFunding = (run: Pick<RunDetail, "status" | "failureCode">) =>
  run.status === "paused_auth" && run.failureCode === "execution_limit";

/** The member's one-Run override: resume now with paid models allowed. */
function PaidRunControl({ run }: { run: RunDetail }) {
  const funding = useQuery(aiFunding.status.queryOptions({}));
  const control = useMutation(runOperations.control.mutationOptions());
  return (
    <Stack gap="sm" className="items-end">
      <PaidRunButton
        label="Run now, paid allowed"
        budget={funding.data}
        pending={control.isPending}
        onConfirm={(paidOverBudgetUsd) =>
          control.mutate({
            runId: run.publicId,
            action: "run_now_paid",
            ...(paidOverBudgetUsd !== undefined && { paidOverBudgetUsd }),
          })
        }
      />
      {run.dispatch.error ? (
        <p className="max-w-md text-right text-xs break-words text-muted-foreground">
          {run.dispatch.error}
        </p>
      ) : null}
      {control.isError ? (
        <StatusText tone="destructive">{control.error.message}</StatusText>
      ) : null}
    </Stack>
  );
}

function RunControls({ run }: { run: RunDetail }) {
  return (
    <Stack gap="sm">
      {waitsForFunding(run) ? (
        <DetailAction>
          <PaidRunControl run={run} />
        </DetailAction>
      ) : null}
      <DetailAction>
        <RunActionButtons runId={run.publicId} actions={runActions(run)}>
          {run.purpose === "photo_inventory" &&
          TERMINAL_RUN_STATUSES.has(run.status) ? (
            <p className="max-w-md text-right text-xs text-muted-foreground">
              Reuses these uploaded photos and their existing image analysis.
              The agent groups them again in a separate run.
            </p>
          ) : null}
        </RunActionButtons>
      </DetailAction>
      {runInputsErased(run.retirementReason) ? (
        <p className="text-xs text-muted-foreground">
          Retired after an unrelated source: its inputs and targets were erased
          with that Email, so it can’t be retried or restarted.
        </p>
      ) : null}
      <RunLineageAndInputs run={run} />
    </Stack>
  );
}

/** Where this run came from, what replaced it, and the inputs a restart copies. */
function RunLineageAndInputs({ run }: { run: RunDetail }) {
  const links = [
    ["Parent run", run.parentRunId],
    ["Retry of", run.predecessorRunPublicId],
    ["Restarted as", run.successorRunPublicId],
  ] as const;
  if (
    !run.restartInputs &&
    !run.cause &&
    !run.attempt &&
    !links.some(([, publicId]) => publicId)
  )
    return null;
  return (
    <Stack gap="sm">
      {run.cause || run.attempt ? (
        <p className="text-xs text-muted-foreground">
          {[
            run.cause ? humanize(run.cause) : null,
            run.attempt ? `Attempt ${run.attempt}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
      {links.map(([label, publicId]) =>
        publicId ? (
          <RunLink key={label} label={label} publicId={publicId} />
        ) : null,
      )}
      {run.restartInputs ? (
        <Panel tone="default">
          <Disclosure summary="Restart inputs">
            <p className="text-xs text-muted-foreground">
              Exactly what “Start new run with same inputs” copies. Proposals,
              decisions, and the agent conversation are not carried over.
            </p>
            <pre
              aria-label="Restart inputs JSON"
              className="mt-2 max-h-96 overflow-auto bg-muted p-2 font-mono text-xs"
            >
              {JSON.stringify(run.restartInputs, null, 2)}
            </pre>
          </Disclosure>
        </Panel>
      ) : null}
    </Stack>
  );
}

function AgentSurface({ run }: { run: RunDetail }) {
  if (!ACTIVE_STATUSES.has(run.status)) {
    return <TerminalAgentSurface run={run} />;
  }
  return <ActiveAgentSurface run={run} />;
}

function agentWorkHeadline(
  run: RunDetail,
  isPhotoRun: boolean,
  proposedGroups?: number,
): string {
  if (run.status === "completed")
    return isPhotoRun ? "Photo review complete" : "Purchase import complete";
  if (run.status === "failed" || run.status === "dispatch_failed")
    return "Agent work stopped";
  if (isPhotoRun && proposedGroups)
    return `${proposedGroups} item ${proposedGroups === 1 ? "group is" : "groups are"} ready for review`;
  if (isPhotoRun) return "Preparing photo groups";
  return "Working through purchase evidence";
}

/** The line under the headline, in the unit the run works in. */
function agentWorkDetail(run: RunDetail, settledGroups?: number) {
  if (run.purpose === "photo_inventory") {
    const photos = run.targets.filter(
      (target) => target.targetType === "image",
    ).length;
    return `${photos} ${photos === 1 ? "photo" : "photos"} received${settledGroups ? ` · ${settledGroups} groups settled` : ""}`;
  }
  return `${run.ordersSeen} ${run.ordersSeen === 1 ? "order" : "orders"} seen · ${run.imported} imported · ${run.updated} updated`;
}

const USAGE_SETTLE_MS = 60_000;

function AgentWorkOverview({
  run,
  messages,
  modelUsage,
  proposedGroups,
  settledGroups,
  additionalWork = [],
}: {
  run: RunDetail;
  messages: readonly AgentConversationMessage[];
  modelUsage: readonly AgentModelUsage[] | undefined;
  proposedGroups?: number;
  settledGroups?: number;
  additionalWork?: AgentWorkItem[];
}) {
  // The last model call can land after the final poll, so usage keeps
  // refreshing until the Run has settled; only then can a token difference
  // mean a call the usage hook missed rather than a stale read.
  const settledAt = run.endedAt
    ? Date.parse(run.endedAt) + USAGE_SETTLE_MS
    : Number.POSITIVE_INFINITY;
  const usage = useQuery({
    ...runOperations.aiUsage.queryOptions({ runId: run.publicId, limit: 1 }),
    // Until a read (or a failed one, so errors cannot poll forever) lands
    // after the settle point, including a cached read from before it when the
    // page is revisited later.
    refetchInterval: (query) =>
      run.status === "running" ||
      run.status.startsWith("paused") ||
      (run.endedAt !== null &&
        Math.max(query.state.dataUpdatedAt, query.state.errorUpdatedAt) <=
          settledAt)
        ? 5_000
        : false,
  });
  const usageSettled = usage.dataUpdatedAt > settledAt;
  const work = [
    ...summarizeAgentWork(messages, run.operations),
    ...additionalWork,
  ];
  const isPhotoRun = run.purpose === "photo_inventory";
  const plannedSteps = isPhotoRun
    ? plannedPhotoWorkSteps(work, run.status, proposedGroups ?? 0)
    : [];
  const headline = agentWorkHeadline(run, isPhotoRun, proposedGroups);
  const detail = agentWorkDetail(run, settledGroups);
  const wallMs = Math.max(
    0,
    (run.endedAt ? Date.parse(run.endedAt) : Date.now()) -
      Date.parse(run.startedAt),
  );
  const workCount = (item: AgentWorkItem) => {
    if (
      item.kind === "image-description" ||
      item.kind === "image-description-reused"
    )
      return `${item.completed} ${item.completed === 1 ? "photo" : "photos"}`;
    if (item.completed < 2) return null;
    if (item.kind === "catalog" || item.kind === "records")
      return `${item.completed} lookups`;
    return `${item.completed} times`;
  };
  return (
    <Panel tone="muted" headingAs="h3" title="Work at a glance">
      <p className="text-sm" aria-live="polite">
        {headline}
      </p>
      <p className="text-xs text-muted-foreground">{detail}</p>
      <p className="mt-2 text-xs text-muted-foreground">
        Total run wall time{" "}
        <strong className="font-semibold text-foreground tabular-nums">
          {formatWorkDuration(wallMs)}
        </strong>
        {run.endedAt ? null : " · still running"}
      </p>
      {usage.data ? (
        <div className="mt-1" aria-live="polite">
          <p className="text-xs text-muted-foreground">
            Run and all nested work
          </p>
          <AiCost cost={usage.data} />
        </div>
      ) : null}
      <AgentContextPerCall messages={messages} />
      <AgentTokenAccounting
        piUsage={modelUsage}
        recorded={usage.data?.tokensByModel}
        settled={usageSettled}
      />
      <div className="mt-3 border-t border-border pt-2">
        <RecordList
          variant="timeline"
          aria-label="Run steps"
          empty="No completed work steps have been recorded yet."
        >
          {work.map((item) => {
            const state = workItemState(item);
            const toolMs =
              item.timing === "tool" ? item.durationMs : item.attemptMs;
            const elapsedMs =
              item.timing === "elapsed" ? item.durationMs : null;
            const total =
              elapsedMs !== null
                ? formatWorkDuration(elapsedMs)
                : toolMs !== null && toolMs !== undefined
                  ? `≥${formatWorkDuration(toolMs)}`
                  : null;
            const evidence = [
              workCount(item),
              item.failed ? `${item.failed} failed` : null,
              item.running ? `${item.running} running` : null,
            ].filter((part) => part !== null);
            return (
              <RecordRow
                key={item.kind}
                leading={<RecordDot state={state} label={STEP_LABEL[state]} />}
                primary={item.label}
                secondary={evidence.length ? evidence.join(" · ") : null}
                trailing={total}
                detail={
                  toolMs !== null && toolMs !== undefined ? (
                    <RecordDetail summary="Timing">
                      <StepTiming
                        rows={[
                          ["Tool / attempt", formatWorkDuration(toolMs)],
                          [
                            "Waiting",
                            item.waitingMs === null ||
                            item.waitingMs === undefined
                              ? "—"
                              : `≥${formatWorkDuration(item.waitingMs)}`,
                            item.waitingMs === undefined
                              ? "No waiting interval recorded"
                              : "Photo batch wall time outside summed completed attempts; a lower bound",
                          ],
                          [
                            "Total wall",
                            total ?? "—",
                            item.timing === "tool"
                              ? "Lower bound: summed tool calls; agent time is unmeasured"
                              : undefined,
                          ],
                        ]}
                      />
                    </RecordDetail>
                  ) : null
                }
              />
            );
          })}
          {plannedSteps.map((step) => (
            <RecordRow
              key={`planned-${step.kind}`}
              leading={<RecordDot state="not_reached" label="Not reached" />}
              primary={
                <span className="text-muted-foreground">{step.label}</span>
              }
              secondary={
                step.status === "waiting_for_you"
                  ? "Waiting for your review"
                  : "Upcoming"
              }
            />
          ))}
          {run.agentModelMs > 0 ? (
            <RecordRow
              leading={<RecordDot state="done" label={STEP_LABEL.done} />}
              primary="Agent model turns"
              secondary="Lower bound: measured model calls only"
              trailing={`≥${formatWorkDuration(run.agentModelMs)}`}
            />
          ) : messages.length && run.endedAt ? (
            <RecordRow
              leading={<RecordDot state="skipped" label="Not recorded" />}
              primary="Agent model turns"
              secondary="No model-turn duration was stored for this run"
              trailing="Not recorded"
            />
          ) : null}
        </RecordList>
      </div>
      <p className="mt-2 text-2xs text-muted-foreground">
        — means no timestamped interval was recorded. Agent model time includes
        reasoning and generation; it is measured per turn, then summed for the
        run, without attributing it to individual steps. Photo waiting is a
        lower bound; attempt time includes executor and network latency.
      </p>
    </Panel>
  );
}

const STEP_LABEL = {
  done: "Done",
  running: "Running",
  warning: "Some attempts failed",
  failed: "Failed",
} as const satisfies Partial<Record<ReportRowState, string>>;

function workItemState(item: AgentWorkItem): keyof typeof STEP_LABEL {
  if (item.running) return "running";
  if (item.failed) return item.completed ? "warning" : "failed";
  return item.completed ? "done" : "running";
}

/** A step's timing breakdown, each figure with its caveat in text rather than a tooltip. */
function StepTiming({
  rows,
}: {
  rows: readonly (readonly [string, string, string?])[];
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 tabular-nums">
      {rows.map(([label, value, note]) => (
        <Fragment key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd>
            {value}
            {note ? (
              <span className="text-muted-foreground"> · {note}</span>
            ) : null}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

function PhotoAgentWorkOverview({
  run,
  messages,
  modelUsage,
}: {
  run: RunDetail;
  messages: readonly AgentConversationMessage[];
  modelUsage: readonly AgentModelUsage[] | undefined;
}) {
  const review = usePhotoRunReview(run.publicId, run.status, runHasAgent(run));
  const descriptionWork = summarizePhotoDescriptions(
    review.data?.images ?? [],
    run.startedAt,
  );
  return (
    <AgentWorkOverview
      run={run}
      messages={messages}
      modelUsage={modelUsage}
      additionalWork={descriptionWork}
      proposedGroups={
        review.data?.review.proposals.filter(
          (proposal) => proposal.state === "proposed",
        ).length
      }
      settledGroups={
        review.data?.review.proposals.filter(
          (proposal) => proposal.state !== "proposed",
        ).length
      }
    />
  );
}

function AgentOverview({
  run,
  conversation,
}: {
  run: RunDetail;
  conversation: AgentConversation | undefined;
}) {
  const messages = conversation?.messages ?? [];
  const modelUsage = conversation?.modelUsage;
  return run.purpose === "photo_inventory" ? (
    <PhotoAgentWorkOverview
      run={run}
      messages={messages}
      modelUsage={modelUsage}
    />
  ) : (
    <AgentWorkOverview run={run} messages={messages} modelUsage={modelUsage} />
  );
}

function useAbsentAgentRefresh(
  phase: string,
  dispatchEventId: string | null | undefined,
  observation: { refresh: () => void },
) {
  useEffect(() => {
    if (phase !== "absent" || !dispatchEventId) return;
    const timer = window.setInterval(() => observation.refresh(), 2_500);
    return () => window.clearInterval(timer);
  }, [phase, dispatchEventId, observation]);
}

/** A one-off `GET …/agent`: the whole conversation snapshot for a stopped run. */
async function fetchAgentHistory(publicId: string) {
  const response = await fetch(agentUrl(publicId), {
    credentials: "same-origin",
  });
  if (!response.ok)
    throw new Error(`Agent history responded ${response.status}`);
  return agentConversationSchema.parse(await response.json());
}

function TerminalAgentSurface({ run }: { run: RunDetail }) {
  // The Cubby agent conversation route, not a Cubby operation.
  const history = useQuery({
    queryKey: ["agent-history", run.publicId],
    queryFn: () => fetchAgentHistory(run.publicId),
    // The server ends the Run inside the finish tool, a moment before the
    // coordinator commits that tool's result; a read in between is missing
    // it, so keep reading until the conversation settles.
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1_000 : false,
  });
  return (
    <Section caption="This terminal run is view-only. The complete materialized conversation remains available as durable evidence.">
      {history.isLoading ? (
        <StatusText>Loading agent history…</StatusText>
      ) : null}
      {history.isError ? (
        <StatusText tone="destructive">{history.error.message}</StatusText>
      ) : null}
      {history.data ? (
        <>
          <AgentOverview run={run} conversation={history.data} />
          <AgentTranscript
            messages={history.data.messages}
            settlements={history.data.settlements}
            live={history.data.status === "running"}
          />
        </>
      ) : null}
    </Section>
  );
}

function ActiveAgentSurface({ run }: { run: RunDetail }) {
  const awaitingReview =
    run.status === "needs_review" ||
    Boolean(run.latestProgress?.awaitingApproval);
  const [prompt, setPrompt] = useState("");
  const queryClient = useQueryClient();
  // Shared with the photo review, which refreshes from the same stream.
  const observation = useAgentObservation(run.publicId);
  const agent = useSyncExternalStore(
    observation.subscribe,
    observation.getSnapshot,
    () => EMPTY_AGENT_SNAPSHOT,
  );
  useAbsentAgentRefresh(agent.phase, run.dispatch?.eventId, observation);
  const promptMutation = useMutation({
    mutationFn: async (value: string) => {
      const response = await fetch(agentUrl(run.publicId), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          agentPromptSchema.parse({ kind: "user", body: value }),
        ),
      });
      if (!response.ok)
        throw new Error(`Agent prompt responded ${response.status}`);
      return response.json();
    },
    onSuccess: () => {
      setPrompt("");
      observation.refresh();
    },
  });
  const abortMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch(`${agentUrl(run.publicId)}/abort`, {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok)
        throw new Error(`Agent abort responded ${response.status}`);
    },
    onSuccess: () => {
      observation.refresh();
      void invalidateOperationTags(queryClient, ripple.runOnly);
    },
  });
  const messages = agent.conversation?.messages ?? [];

  return (
    <Section caption="The durable operation timeline is below; this conversation stays current through the agent stream.">
      <Row gap="sm" align="center">
        <Badge
          variant={
            !awaitingReview && agent.phase === "live" ? "positive" : "secondary"
          }
        >
          {awaitingReview ? "Awaiting review" : agent.phase}
        </Badge>
      </Row>
      {agent.phase === "absent" ? (
        <p className="text-sm text-muted-foreground">
          The agent conversation is not available yet. This view will connect
          automatically once the agent starts.
          {run.purpose === "photo_inventory" ? null : (
            <a
              className="ml-1 text-primary hover:underline"
              href="/api/import/agent/oauth/start"
            >
              Connect agent
            </a>
          )}
        </p>
      ) : null}
      <form
        className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          const value = prompt.trim();
          if (value) promptMutation.mutate(value);
        }}
      >
        <label className="sr-only" htmlFor="import-agent-prompt">
          Agent prompt
        </label>
        <input
          id="import-agent-prompt"
          className="h-11 rounded-md border border-input bg-background px-3 text-sm"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Give the import agent a concise instruction"
          disabled={promptMutation.isPending || agent.phase === "absent"}
        />
        <Button
          type="submit"
          disabled={
            !prompt.trim() ||
            promptMutation.isPending ||
            agent.phase === "absent"
          }
        >
          Send prompt
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => abortMutation.mutate()}
          disabled={abortMutation.isPending}
        >
          Abort agent
        </Button>
      </form>
      {promptMutation.isError || abortMutation.isError || agent.error ? (
        <StatusText tone="destructive">
          {promptMutation.error?.message ??
            abortMutation.error?.message ??
            agent.error?.message}
        </StatusText>
      ) : null}
      <AgentOverview run={run} conversation={agent.conversation} />
      <AgentTranscript
        messages={messages}
        settlements={agent.conversation?.settlements ?? []}
        live={agent.conversation?.status === "running"}
      />
    </Section>
  );
}

/**
 * The run's live read (agent transcript, operations, evidence), polled while
 * the run is active. Every run slot shares it through this one query key.
 * A live agent stream invalidates it on each agent change, so the poll
 * relaxes to a safety net for writes the agent does not make.
 */
function useRun(runId: RunOut["id"]) {
  const [agentLive, setAgentLive] = useState(false);
  const query = useQuery({
    ...runOperations.work.queryOptions({ runId }),
    refetchInterval: (current) =>
      current.state.data && ACTIVE_STATUSES.has(current.state.data.status)
        ? agentLive
          ? 30_000
          : 3_000
        : false,
  });
  const live = useAgentReviewSync(
    query.data?.publicId ?? "",
    Boolean(query.data && isActiveRun(query.data) && runHasAgent(query.data)),
  );
  useEffect(() => setAgentLive(live), [live]);
  return query;
}

/**
 * `useRun`, plus — for the one slot that owns it — a refresh of the Run
 * record once the run moves on (a control action, or the agent finishing):
 * the hero and fields read the record, not this poll.
 */
function useSyncedRun(record: RunOut, syncRecord: boolean) {
  const runQuery = useRun(record.id);
  const queryClient = useQueryClient();
  const liveStatus = runQuery.data?.status;
  useEffect(() => {
    if (syncRecord && liveStatus !== undefined && liveStatus !== record.status)
      void invalidateOperationTags(queryClient, ripple.runOnly);
  }, [syncRecord, liveStatus, record.status, queryClient]);
  return runQuery;
}

function RunGate({
  record,
  children,
}: {
  record: RunOut;
  children: (run: RunDetail) => ReactNode;
}) {
  const runQuery = useSyncedRun(record, true);
  if (runQuery.isLoading) return <StatusText>Loading import run…</StatusText>;
  if (runQuery.isError)
    return <StatusText tone="destructive">{runQuery.error.message}</StatusText>;
  return runQuery.data ? children(runQuery.data) : null;
}

const isActiveRun = (run: RunDetail) => ACTIVE_STATUSES.has(run.status);
const isStoppedRun = (run: RunDetail) => !isActiveRun(run);

/** Whether the controls slot has anything to offer for this run's state. */
function hasRunControls(run: RunDetail): boolean {
  return (
    runActions(run).length > 0 ||
    waitsForFunding(run) ||
    runInputsErased(run.retirementReason) ||
    Boolean(
      run.restartInputs ||
      run.predecessorRunPublicId ||
      run.successorRunPublicId,
    )
  );
}

/**
 * One declared import-run slot. Each slot gates its own visibility on the
 * shared run read: a slot that does not apply renders nothing and hides its
 * section card. The `primary` slot also owns the loading and error copy and
 * the record refresh, so the rest stay quiet until the run has loaded.
 */
function ImportRunSlot({
  record,
  visible = () => true,
  primary = false,
  children,
}: {
  record: RunOut;
  visible?: (run: RunDetail) => boolean;
  primary?: boolean;
  children: (run: RunDetail) => ReactNode;
}) {
  const runQuery = useSyncedRun(record, primary);
  const run = runQuery.data;
  const shown = run ? visible(run) : primary;
  useSectionEmpty(runQuery.isSuccess && !shown);
  if (!run) {
    if (!primary) return null;
    if (runQuery.isError)
      return (
        <StatusText tone="destructive">{runQuery.error.message}</StatusText>
      );
    return <StatusText>Loading import run…</StatusText>;
  }
  return shown ? children(run) : <StatusText>No items.</StatusText>;
}

/** Run detail slot: control actions, lineage and restart inputs. */
export function RunImportControls({ record }: { record: RunOut }) {
  return (
    <ImportRunSlot record={record} visible={hasRunControls}>
      {(run) => <RunControls run={run} />}
    </ImportRunSlot>
  );
}

/** Run detail slot: the live agent conversation while the run is live. */
export function RunImportAgentActive({ record }: { record: RunOut }) {
  return (
    <ImportRunSlot record={record} visible={isActiveRun}>
      {(run) => <ActiveAgentSurface run={run} />}
    </ImportRunSlot>
  );
}

/** Run detail slot: the view-only agent history once the run has stopped. */
export function RunImportAgentStopped({ record }: { record: RunOut }) {
  return (
    <ImportRunSlot record={record} visible={isStoppedRun}>
      {(run) => <TerminalAgentSurface run={run} />}
    </ImportRunSlot>
  );
}

/**
 * Run detail slot for an agent-proposed photo review.
 */
export function RunPhotoBatch({ record }: { record: RunOut }) {
  return (
    <RunGate record={record}>
      {(run) => (
        <>
          <RunControls run={run} />
          <PhotoImportRunView run={run} />
          {run.dispatch?.eventId ? (
            <Section
              headingAs="h2"
              title={isActiveRun(run) ? "Live agent" : "Agent history"}
            >
              <AgentSurface run={run} />
            </Section>
          ) : null}
          <Panel tone="default">
            <Disclosure summary="Timeline and system log">
              <div className="grid gap-4 pt-2">
                <h3 className="text-sm font-medium">Durable transcript</h3>
                <EntityReportSlot
                  slot="run.import-timeline"
                  id={run.publicId}
                  status={run.status}
                  nested
                />
                <h3 className="text-sm font-medium">System log</h3>
                <EntityReportSlot
                  slot="run.import-debug-log"
                  id={run.publicId}
                  status={run.status}
                  nested
                />
              </div>
            </Disclosure>
          </Panel>
        </>
      )}
    </RunGate>
  );
}

function RunLink({ label, publicId }: { label: string; publicId: string }) {
  return (
    <Row wrap gap="sm" align="center" justify="between" className="text-sm">
      <span className="text-muted-foreground">{label}</span>
      <a
        className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
        href={runHref(publicId)}
        aria-label={`${label} ${publicId}`}
      >
        {publicId}
        <ArrowSquareOutIcon className="size-3" />
      </a>
    </Row>
  );
}

/** Funding controls apply to every Run; agent commands stay with imports. */
export function RunAgentActions({ record }: { record: RunOut }) {
  return agentImportRunPurpose.safeParse(record.purpose).success ||
    waitsForFunding(record) ? (
    <RunAgentActionRead record={record} />
  ) : null;
}
function RunAgentActionRead({ record }: { record: RunOut }) {
  const query = useSyncedRun(record, true);
  const agentRun =
    query.data && agentImportRunPurpose.safeParse(query.data.purpose).success;
  return query.data ? (
    <>
      {waitsForFunding(query.data) ? <PaidRunControl run={query.data} /> : null}
      {query.data.purpose === "photo_inventory" ? (
        <PhotoRunGroupingAction run={query.data} />
      ) : null}
      {agentRun ? (
        <RunActionButtons
          runId={query.data.publicId}
          actions={runActions(query.data)}
        />
      ) : null}
    </>
  ) : null;
}
