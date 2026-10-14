import {
  agentConversationSchema,
  agentPromptSchema,
  type AgentConversationMessage,
  type AgentConversationPart,
  type AgentConversationSettlement,
} from "@cubby/schemas/agent-conversation";
import type { ReportRowState } from "@cubby/schemas/entity-report";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import type { RunOut } from "@cubby/schemas/run";
import { runInputsErased } from "@cubby/schemas/run-fields";
import { humanize } from "@cubby/shared";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { z } from "zod";

import { runHref } from "~/app/purchases/purchase-import-links";
import {
  agentUrl,
  runHasAgent,
  useAgentObservation,
  type AgentConversationObservationSnapshot,
} from "~/app/runs/agent-observation";
import { usePhotoRunReview } from "~/app/runs/photo-group-review";
import {
  PhotoImportRunView,
  PhotoRunGroupingAction,
} from "~/app/runs/photo-run-detail";
import type { RunDetail } from "~/contracts/run.contract";
import { DetailAction } from "~/entity/entity-detail/detail-action-bar";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { run as runOperations } from "~/integrations/tanstack-query/generated/catalog.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { AiCost } from "~/ui/common/ai-cost";
import {
  RecordDetail,
  RecordDot,
  RecordList,
  RecordRow,
} from "~/ui/common/record-list";
import { useSectionEmpty } from "~/ui/data-table/detail-section-state";
import { Row, Section, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";
import { ShortcodeProse } from "~/ui/shortcode-prose";

import { AgentContextPerCall } from "./agent-context-breakdown";
import {
  formatWorkDuration,
  plannedPhotoWorkSteps,
  summarizeAgentWork,
  summarizePhotoDescriptions,
  type AgentWorkItem,
} from "./agent-work-summary";

const ACTIVE_RUN_STATUSES = new Set([
  "running",
  "paused_auth",
  "paused_offline",
  "paused_approval",
  "paused",
]);

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
  if (ACTIVE_RUN_STATUSES.has(run.status))
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

function RunControls({ run }: { run: RunDetail }) {
  return (
    <Stack gap="sm">
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
        <details className="border border-border bg-card p-3">
          <summary className="cursor-pointer font-medium">
            Restart inputs
          </summary>
          <p className="mt-2 text-xs text-muted-foreground">
            Exactly what “Start new run with same inputs” copies. Proposals,
            decisions, and the agent conversation are not carried over.
          </p>
          <pre
            aria-label="Restart inputs JSON"
            className="mt-2 max-h-96 overflow-auto bg-muted p-2 font-mono text-xs"
          >
            {JSON.stringify(run.restartInputs, null, 2)}
          </pre>
        </details>
      ) : null}
    </Stack>
  );
}

function AgentSurface({ run }: { run: RunDetail }) {
  if (!ACTIVE_RUN_STATUSES.has(run.status)) {
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
  if (run.status === "paused_approval") return "Waiting for your approval";
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

function AgentWorkOverview({
  run,
  messages,
  proposedGroups,
  settledGroups,
  additionalWork = [],
}: {
  run: RunDetail;
  messages: readonly AgentConversationMessage[];
  proposedGroups?: number;
  settledGroups?: number;
  additionalWork?: AgentWorkItem[];
}) {
  const usage = useQuery({
    ...runOperations.aiUsage.queryOptions({ runId: run.publicId, limit: 1 }),
    refetchInterval:
      run.status === "running" || run.status.startsWith("paused")
        ? 5_000
        : false,
  });
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
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <h3 className="text-sm font-semibold">Work at a glance</h3>
      <p className="mt-1 text-sm" aria-live="polite">
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
          <AiCost cost={usage.data} />
        </div>
      ) : null}
      <AgentContextPerCall messages={messages} />
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
    </div>
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

const SETTLEMENT_STATE = {
  done: "done",
  unanswered: "warning",
} as const satisfies Record<
  AgentConversationSettlement["outcome"],
  ReportRowState
>;

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
}: {
  run: RunDetail;
  messages: readonly AgentConversationMessage[];
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
  messages,
}: {
  run: RunDetail;
  messages: readonly AgentConversationMessage[];
}) {
  return run.purpose === "photo_inventory" ? (
    <PhotoAgentWorkOverview run={run} messages={messages} />
  ) : (
    <AgentWorkOverview run={run} messages={messages} />
  );
}

function AgentTranscriptDisclosure({
  messages,
  settlements,
}: {
  messages: AgentConversationMessage[];
  settlements: AgentConversationSettlement[];
}) {
  return (
    <details className="border-t border-border pt-2">
      <summary className="cursor-pointer text-sm font-medium">
        Agent messages and tool calls · {messages.length} messages
      </summary>
      <AgentTranscript messages={messages} settlements={settlements} />
    </details>
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
    <Section description="This terminal run is view-only. The complete materialized conversation remains available as durable evidence.">
      {history.isLoading ? (
        <StatusText>Loading agent history…</StatusText>
      ) : null}
      {history.isError ? (
        <StatusText tone="destructive">{history.error.message}</StatusText>
      ) : null}
      {history.data ? (
        <>
          <AgentOverview run={run} messages={history.data.messages} />
          <AgentTranscriptDisclosure
            messages={history.data.messages}
            settlements={history.data.settlements}
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
    <Section description="The durable operation timeline is below; this conversation stays current through the agent stream.">
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
      <AgentOverview run={run} messages={messages} />
      <AgentTranscriptDisclosure
        messages={messages}
        settlements={agent.conversation?.settlements ?? []}
      />
    </Section>
  );
}

function AgentTranscript({
  messages,
  settlements,
}: {
  messages: AgentConversationMessage[];
  settlements: AgentConversationSettlement[];
}) {
  if (messages.length === 0 && settlements.length === 0)
    return <StatusText>No agent messages have been recorded yet.</StatusText>;
  return (
    <div
      className="max-h-[70vh] overflow-auto border-t border-border pt-2"
      aria-label="Agent conversation transcript"
    >
      {messages.map((message) => (
        <AgentMessage key={message.id} message={message} />
      ))}
      {settlements.length ? (
        <RecordList aria-label="Operation settlements" className="pt-2">
          {settlements.map((settlement) => (
            <RecordRow
              key={settlement.operationId}
              leading={
                <RecordDot
                  state={SETTLEMENT_STATE[settlement.outcome]}
                  label={humanize(settlement.outcome)}
                />
              }
              primary={
                <code className="font-mono text-xs">
                  {settlement.operationId}
                </code>
              }
              secondary={settlement.reason ?? humanize(settlement.outcome)}
              clip={false}
            />
          ))}
        </RecordList>
      ) : null}
    </div>
  );
}

function AgentMessage({ message }: { message: AgentConversationMessage }) {
  return (
    <article className="grid gap-1 border-b border-border py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={message.role === "assistant" ? "default" : "outline"}>
          {message.purpose}
        </Badge>
        <span className="text-xs text-muted-foreground">{message.display}</span>
      </div>
      {message.signal ? (
        <p className="font-mono text-xs text-muted-foreground">
          {message.signal.type}
          {message.signal.attributes
            ? ` · ${Object.entries(message.signal.attributes)
                .map(([key, value]) => `${key}=${value}`)
                .join(" ")}`
            : ""}
        </p>
      ) : null}
      <div className="grid gap-2">
        {message.parts.map((part) => (
          <AgentPart
            key={`${message.id}:${part.type}:${JSON.stringify(part)}`}
            part={part}
          />
        ))}
      </div>
    </article>
  );
}

function AgentPart({ part }: { part: AgentConversationPart }) {
  if (part.type === "text" || part.type === "reasoning") {
    return (
      <p
        className={
          part.type === "reasoning"
            ? "text-sm text-muted-foreground"
            : "text-sm whitespace-pre-wrap"
        }
      >
        <ShortcodeProse>{part.text}</ShortcodeProse>
      </p>
    );
  }
  if (part.type === "file") {
    return (
      <span className="text-sm text-muted-foreground">
        {part.filename ?? "Agent attachment"} · {part.mediaType}
      </span>
    );
  }
  return (
    <details className="border border-border bg-muted/30 p-2 text-xs">
      <summary className="cursor-pointer font-mono">
        {part.toolName} · {part.state}
        {part.durationMs !== undefined ? ` · ${part.durationMs}ms` : ""}
      </summary>
      <div className="grid gap-2 pt-2">
        <ToolValue label="Arguments" value={part.input} />
        {part.state === "output-available" ? (
          <ToolValue label="Result" value={part.output} />
        ) : null}
        {part.state === "output-error" ? (
          <p className="text-destructive">{part.errorText}</p>
        ) : null}
      </div>
    </details>
  );
}

function formattedToolValue(value: unknown): string {
  const parsedValue = z.json().safeParse(value);
  if (!parsedValue.success) return "No output";
  const serialized = z.string().safeParse(parsedValue.data);
  if (!serialized.success)
    return JSON.stringify(parsedValue.data, null, 2) ?? "null";
  const source = serialized.data.startsWith("Structured content:\n")
    ? serialized.data.slice("Structured content:\n".length)
    : serialized.data;
  try {
    const parsed = z.json().parse(JSON.parse(source));
    return JSON.stringify(parsed, null, 2) ?? "null";
  } catch {
    return serialized.data;
  }
}

function ToolValue({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <p className="text-muted-foreground">{label}</p>
      <pre className="max-h-80 overflow-auto bg-background p-2 font-mono text-xs break-words whitespace-pre-wrap">
        {formattedToolValue(value)}
      </pre>
    </div>
  );
}

/**
 * The run's live read (agent transcript, operations, evidence), polled while
 * the run is active. Every run slot shares it through this one query key.
 */
function useRun(runId: RunOut["id"]) {
  return useQuery({
    ...runOperations.work.queryOptions({ runId }),
    refetchInterval: (query) =>
      query.state.data && ACTIVE_RUN_STATUSES.has(query.state.data.status)
        ? 3_000
        : false,
  });
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

const isActiveRun = (run: RunDetail) => ACTIVE_RUN_STATUSES.has(run.status);
const isStoppedRun = (run: RunDetail) => !isActiveRun(run);

/** Whether the controls slot has anything to offer for this run's state. */
function hasRunControls(run: RunDetail): boolean {
  return (
    runActions(run).length > 0 ||
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
            <Section title={isActiveRun(run) ? "Live agent" : "Agent history"}>
              <AgentSurface run={run} />
            </Section>
          ) : null}
          <details className="border border-border bg-card p-4">
            <summary className="cursor-pointer font-medium">
              Timeline and system log
            </summary>
            <div className="mt-4 grid gap-4">
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
          </details>
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

/** The same cached work read supplies agent controls on every detail tab. */
export function RunAgentActions({ record }: { record: RunOut }) {
  return agentImportRunPurpose.safeParse(record.purpose).success ? (
    <RunAgentActionRead record={record} />
  ) : null;
}
function RunAgentActionRead({ record }: { record: RunOut }) {
  const query = useSyncedRun(record, true);
  return query.data ? (
    <>
      {query.data.purpose === "photo_inventory" ? (
        <PhotoRunGroupingAction run={query.data} />
      ) : null}
      <RunActionButtons
        runId={query.data.publicId}
        actions={runActions(query.data)}
      />
    </>
  ) : null;
}
