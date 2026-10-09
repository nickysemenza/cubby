import {
  agentConversationSchema,
  agentPromptSchema,
  type AgentConversationMessage,
  type AgentConversationPart,
  type AgentConversationSettlement,
} from "@cubby/schemas/agent-conversation";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { initiateRunEvidenceUploadInput } from "@cubby/schemas/purchase-import";
import type { RunOut } from "@cubby/schemas/run";
import { sha256Hex } from "@cubby/shared/sha256";
import { humanize } from "@cubby/shared/text-case";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
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
import { DetailAction } from "~/entity/entity-detail/detail-action-context";
import { EntityReportSlot } from "~/entity/entity-detail/report-slot";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { purchaseImport } from "~/integrations/tanstack-query/generated/purchase-import.gen";
import { run as runOperations } from "~/integrations/tanstack-query/generated/run.gen";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { putPresignedObject } from "~/lib/presigned-upload";
import { formatCurrency } from "~/lib/utils";
import { useSectionVisible } from "~/ui/data-table/detail-page";
import { Row, Section, Stack } from "~/ui/layout";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { StatusText } from "~/ui/primitives/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";
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

const EVIDENCE_GAP_STATES = new Set([
  "needs_evidence",
  "unavailable",
  "unresolved",
]);

/**
 * Every control this run's state offers, in one list: live pause handoffs and
 * stop, dispatch recovery for a run the agent never picked up, evidence
 * recovery for a validation that found none, and the terminal retries.
 */
function runActions(run: RunDetail): RunAction[] {
  const actions: RunAction[] = [];
  if (run.status === "paused_auth" || run.status === "paused_offline")
    actions.push({
      action: "resume",
      label:
        run.status === "paused_auth"
          ? "I've signed in — resume run"
          : "Browser is connected — resume run",
    });
  if (ACTIVE_RUN_STATUSES.has(run.status))
    actions.push({ action: "cancel", label: "Stop run", variant: "outline" });
  const { dispatch } = run;
  if (!dispatch.coordinatorStartedAt && dispatch.state !== "started")
    actions.push(
      {
        action: "retry_dispatch",
        label: "Retry dispatch",
        disabled: dispatch.error === "Awaiting manual evidence upload",
      },
      { action: "abort", label: "Abort", variant: "outline" },
    );
  if (
    run.purpose === "purchase_validation" &&
    (run.status === "needs_review" || run.status === "failed") &&
    run.targets.some((target) => EVIDENCE_GAP_STATES.has(target.state))
  )
    actions.push(
      { action: "upload_evidence", label: "Upload evidence" },
      {
        action: "no_evidence_available",
        label: "No evidence available",
        variant: "outline",
      },
    );
  if (
    TERMINAL_RUN_STATUSES.has(run.status) &&
    agentImportRunPurpose.safeParse(run.purpose).success
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
      {run.status === "paused_auth" || run.status === "paused_offline" ? (
        <Section
          title={
            run.status === "paused_auth"
              ? `Sign in to ${run.vendorAccount?.label ?? "the retailer"}`
              : "Reconnect the Mac browser"
          }
          description={
            run.status === "paused_auth"
              ? "Use the Cubby-managed browser tab on your Mac to finish sign-in. Leave the tab open; the agent will continue with the order page after you resume."
              : "Open the Cubby Mac app and reconnect its browser bridge. Keep the retailer tab open before resuming."
          }
        />
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
      <RunLineageAndInputs run={run} />
      <DetailAction>
        <ManualEvidenceUpload run={run} />
      </DetailAction>
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

function ManualEvidenceUpload({ run }: { run: RunDetail }) {
  const queryClient = useQueryClient();
  const target = run.targets.find((item) => item.state === "needs_evidence");
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!target) throw new Error("This run has no evidence target.");
      const bytes = await file.arrayBuffer();
      const checksum = await sha256Hex(bytes);
      const contentType =
        initiateRunEvidenceUploadInput.shape.contentType.parse(file.type);
      const staged = await purchaseImport.initiateRunEvidenceUpload.call({
        runId: run.publicId,
        targetId: target.id,
        kind: "manual_upload",
        contentType,
        byteSize: file.size,
        checksum,
        filename: file.name,
        sourceMetadata: { filename: file.name },
      });
      // The guarded upload endpoint verifies the persisted manifest and live Run.
      try {
        await putPresignedObject(staged.uploadUrl, bytes, contentType);
      } catch {
        throw new Error("Evidence bytes could not be stored.");
      }
      return runOperations.control.call({
        runId: run.publicId,
        action: "retry_dispatch",
      });
    },
    onSuccess: () => invalidateOperationTags(queryClient, ripple.runOnly),
  });
  if (
    run.purpose !== "purchase_validation" ||
    !["running", "dispatch_failed"].includes(run.status) ||
    !target
  )
    return null;
  return (
    <label className="grid min-h-11 cursor-pointer items-center border border-border px-3 py-2 text-sm font-medium">
      <span>
        {upload.isPending ? "Uploading evidence…" : "Choose evidence file"}
      </span>
      <input
        className="sr-only"
        type="file"
        disabled={upload.isPending}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) upload.mutate(file);
        }}
      />
      {upload.isError ? (
        <StatusText tone="destructive">{upload.error.message}</StatusText>
      ) : null}
    </label>
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
  const enrichment = run.purpose === "product_enrichment";
  if (run.status === "completed")
    return isPhotoRun
      ? "Photo review complete"
      : enrichment
        ? "Product enrichment complete"
        : "Purchase import complete";
  if (run.status === "paused_auth") return "Waiting for retailer sign-in";
  if (run.status === "paused_approval") return "Waiting for your approval";
  if (run.status === "failed" || run.status === "dispatch_failed")
    return "Agent work stopped";
  if (isPhotoRun && proposedGroups)
    return `${proposedGroups} item ${proposedGroups === 1 ? "group is" : "groups are"} ready for review`;
  if (isPhotoRun) return "Preparing photo groups";
  return enrichment
    ? "Reading product pages"
    : "Working through purchase evidence";
}

/** The line under the headline, in the unit the run works in. */
function agentWorkDetail(run: RunDetail, settledGroups?: number) {
  if (run.purpose === "photo_inventory") {
    const photos = run.targets.filter(
      (target) => target.targetType === "image",
    ).length;
    return `${photos} ${photos === 1 ? "photo" : "photos"} received${settledGroups ? ` · ${settledGroups} groups settled` : ""}`;
  }
  if (run.purpose === "product_enrichment")
    return `${run.targets.length} ${run.targets.length === 1 ? "product" : "products"} selected · Research results below`;
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
        <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
          AI spend to date{" "}
          <strong className="font-semibold text-foreground tabular-nums">
            {formatCurrency(usage.data.pricedSubtotal, 4)}
          </strong>
          {usage.data.unpricedCount
            ? ` · ${usage.data.unpricedCount} calls unpriced`
            : null}
        </p>
      ) : null}
      <AgentContextPerCall messages={messages} />
      {work.length || plannedSteps.length || run.agentModelMs > 0 ? (
        <section
          className="mt-3 border-t border-border pt-2"
          aria-label="Run step timing table"
        >
          <Table className="min-w-[760px] tabular-nums">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[14%]" />
              <col className="w-[15%]" />
              <col className="w-[14%]" />
              <col className="w-[13%]" />
              <col className="w-[18%]" />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="h-auto py-2 pr-3 pl-0">Step</TableHead>
                <TableHead className="h-auto py-2 text-right">
                  Lookups / items
                </TableHead>
                <TableHead className="h-auto py-2 text-right">
                  Tool / attempt
                </TableHead>
                <TableHead className="h-auto py-2 text-right">
                  Agent model
                </TableHead>
                <TableHead className="h-auto py-2 text-right">
                  Waiting
                </TableHead>
                <TableHead className="h-auto py-2 pr-0 text-right">
                  Total wall
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {work.map((item) => {
                const Icon = item.completed
                  ? CheckCircleIcon
                  : item.failed && !item.running
                    ? WarningCircleIcon
                    : CircleNotchIcon;
                const toolMs =
                  item.timing === "tool" ? item.durationMs : item.attemptMs;
                const elapsedMs =
                  item.timing === "elapsed" ? item.durationMs : null;
                return (
                  <TableRow key={item.kind}>
                    <TableHead
                      scope="row"
                      className="h-auto py-2 pr-3 pl-0 whitespace-normal text-foreground"
                    >
                      <span className="flex items-center gap-2">
                        <Icon
                          className={`size-3.5 shrink-0 ${item.failed && !item.completed ? "text-destructive" : item.completed ? "text-positive" : "text-muted-foreground"}`}
                          aria-hidden="true"
                        />
                        {item.label}
                      </span>
                    </TableHead>
                    <TableCell className="text-right text-muted-foreground">
                      {workCount(item) ?? "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      {toolMs === null || toolMs === undefined
                        ? "—"
                        : formatWorkDuration(toolMs)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      —
                    </TableCell>
                    <TableCell
                      className="text-right"
                      title={
                        item.waitingMs === undefined
                          ? "No waiting interval recorded"
                          : "Photo batch wall time outside summed completed attempts; a lower bound"
                      }
                    >
                      {item.waitingMs === null || item.waitingMs === undefined
                        ? "—"
                        : `≥${formatWorkDuration(item.waitingMs)}`}
                    </TableCell>
                    <TableCell
                      className="pr-0 text-right"
                      title={
                        item.timing === "tool"
                          ? "Lower bound: summed tool calls; agent time is unmeasured"
                          : undefined
                      }
                    >
                      {elapsedMs !== null
                        ? formatWorkDuration(elapsedMs)
                        : toolMs !== null && toolMs !== undefined
                          ? `≥${formatWorkDuration(toolMs)}`
                          : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
              {plannedSteps.map((step) => (
                <TableRow
                  key={`planned-${step.kind}`}
                  className="text-muted-foreground"
                >
                  <TableHead
                    scope="row"
                    className="h-auto py-2 pr-3 pl-0 whitespace-normal"
                  >
                    <span className="flex items-center gap-2">
                      <CircleIcon
                        className="size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>{step.label}</span>
                    </span>
                  </TableHead>
                  <TableCell colSpan={5}>
                    {step.status === "waiting_for_you"
                      ? "Waiting for your review"
                      : "Upcoming"}
                  </TableCell>
                </TableRow>
              ))}
              {run.agentModelMs > 0 ? (
                <TableRow>
                  <TableHead
                    scope="row"
                    className="h-auto py-2 pr-3 pl-0 whitespace-normal text-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <CheckCircleIcon
                        className="size-3.5 shrink-0 text-positive"
                        aria-hidden="true"
                      />
                      Agent model turns
                    </span>
                  </TableHead>
                  <TableCell className="text-right text-muted-foreground">
                    —
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    —
                  </TableCell>
                  <TableCell className="text-right">
                    {formatWorkDuration(run.agentModelMs)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground">
                    —
                  </TableCell>
                  <TableCell
                    className="pr-0 text-right"
                    title="Lower bound: measured model calls only"
                  >
                    ≥{formatWorkDuration(run.agentModelMs)}
                  </TableCell>
                </TableRow>
              ) : messages.length && run.endedAt ? (
                <TableRow>
                  <TableHead
                    scope="row"
                    className="h-auto py-2 pr-3 pl-0 whitespace-normal text-foreground"
                  >
                    Agent model turns
                  </TableHead>
                  <TableCell
                    colSpan={2}
                    className="p-0 text-right text-muted-foreground"
                  >
                    —
                  </TableCell>
                  <TableCell
                    className="text-right text-muted-foreground"
                    title="No model-turn duration was stored for this run"
                  >
                    Not recorded
                  </TableCell>
                  <TableCell
                    colSpan={2}
                    className="p-0 text-right text-muted-foreground"
                  >
                    —
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </section>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          No completed work steps have been recorded yet.
        </p>
      )}
      <p className="mt-2 text-2xs text-muted-foreground">
        — means no timestamped interval was recorded. Agent model time includes
        reasoning and generation; it is measured per turn, then summed for the
        run, without attributing it to individual steps. Photo waiting is a
        lower bound; attempt time includes executor and network latency.
      </p>
    </div>
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

// eslint-disable-next-line complexity -- Active agent and awaiting-review states share this run surface.
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
      {settlements.map((settlement) => (
        <p
          key={settlement.operationId}
          className="border-t border-border py-2 font-mono text-xs text-muted-foreground"
        >
          {settlement.operationId} · {settlement.outcome}
        </p>
      ))}
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
    run.status === "paused_auth" ||
    run.status === "paused_offline" ||
    runActions(run).length > 0 ||
    Boolean(
      run.restartInputs ||
      run.predecessorRunPublicId ||
      run.successorRunPublicId,
    ) ||
    (run.purpose === "purchase_validation" &&
      run.status === "dispatch_failed" &&
      run.targets.some((item) => item.state === "needs_evidence"))
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
  useSectionVisible(shown);
  if (!run) {
    if (!primary) return null;
    if (runQuery.isError)
      return (
        <StatusText tone="destructive">{runQuery.error.message}</StatusText>
      );
    return <StatusText>Loading import run…</StatusText>;
  }
  return shown ? children(run) : null;
}

/** Run detail slot: sign-in handoffs, control actions, lineage and restart inputs. */
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
              <h3 className="text-sm font-medium">System and Mac log</h3>
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
      <ManualEvidenceUpload run={query.data} />
      <RunActionButtons
        runId={query.data.publicId}
        actions={runActions(query.data)}
      />
    </>
  ) : null;
}
