import { flueImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { initiateRunEvidenceUploadInput } from "@cubby/schemas/purchase-import";
import type { RunOut } from "@cubby/schemas/run";
import {
  createFlueClient,
  type AgentConversationObservationSnapshot,
  type FlueConversationMessage,
  type FlueConversationPart,
} from "@flue/sdk";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { CircleIcon } from "@phosphor-icons/react/dist/csr/Circle";
import { CircleNotchIcon } from "@phosphor-icons/react/dist/csr/CircleNotch";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { z } from "zod";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { runHref } from "~/app/purchases/purchase-import-links";
import { usePhotoRunReview } from "~/app/runs/photo-group-review";
import { PhotoImportRunView } from "~/app/runs/photo-run-detail";
import { Row, Section, Stack } from "~/components/layout";
import { ShortcodeProse } from "~/components/shortcode-prose";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { StatGrid, StatTile } from "~/components/ui/stat-tile";
import { StatusText } from "~/components/ui/status-text";
import type { RunDetail } from "~/contracts/run.contract";
import { purchaseImport, run as runOperations } from "~/entities/run.functions";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { cn, formatCurrency } from "~/lib/utils";

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

const statusBadgeVariant = (status: string): BadgeVariant => {
  if (status === "completed") return "positive";
  if (status === "failed" || status === "cancelled" || status === "aborted")
    return "destructive";
  if (status.startsWith("paused")) return "warning";
  return "secondary";
};

const formatMoment = (value: string | null): string =>
  value ? new Date(value).toLocaleString() : "Still active";

const EMPTY_AGENT_SNAPSHOT: AgentConversationObservationSnapshot = {
  conversation: undefined,
  offset: undefined,
  phase: "loading",
  error: undefined,
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
    flueImportRunPurpose.safeParse(run.purpose).success
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
  target,
  children,
}: {
  runId: RunDetail["publicId"];
  actions: readonly RunAction[];
  target?: Pick<RunControlInput, "operationId" | "approvalId">;
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
            onClick={() =>
              control.mutate({ runId, action: item.action, ...target })
            }
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
      <RunActionButtons runId={run.publicId} actions={runActions(run)}>
        {run.purpose === "photo_inventory" &&
        TERMINAL_RUN_STATUSES.has(run.status) ? (
          <p className="max-w-md text-right text-xs text-muted-foreground">
            Reuses these uploaded photos and their existing image analysis. The
            agent groups them again in a separate run.
          </p>
        ) : null}
      </RunActionButtons>
      <RunLineageAndInputs run={run} />
      <ManualEvidenceUpload run={run} />
    </Stack>
  );
}

/** Where this run came from, what replaced it, and the inputs a restart copies. */
function RunLineageAndInputs({ run }: { run: RunDetail }) {
  const links = [
    ["Started from", run.predecessorRunPublicId],
    ["Restarted as", run.successorRunPublicId],
  ] as const;
  if (!run.restartInputs && !links.some(([, publicId]) => publicId))
    return null;
  return (
    <Stack gap="sm">
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
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const checksum = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
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
      // A presigned object-store PUT, not a Cubby endpoint.
      const stored = await fetch(staged.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: bytes,
      });
      if (!stored.ok) throw new Error("Evidence bytes could not be stored.");
      return runOperations.control.call({
        runId: run.publicId,
        action: "retry_dispatch",
      });
    },
    onSuccess: () => invalidateOperationTags(queryClient, ripple.runOnly),
  });
  if (
    run.purpose !== "purchase_validation" ||
    run.status !== "dispatch_failed" ||
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
  if (run.status === "completed")
    return isPhotoRun ? "Photo review complete" : "Purchase import complete";
  if (run.status === "paused_auth") return "Waiting for retailer sign-in";
  if (run.status === "paused_approval") return "Waiting for your approval";
  if (run.status === "failed" || run.status === "dispatch_failed")
    return "Agent work stopped";
  if (isPhotoRun && proposedGroups)
    return `${proposedGroups} item ${proposedGroups === 1 ? "group is" : "groups are"} ready for review`;
  return isPhotoRun
    ? "Preparing photo groups"
    : "Working through purchase evidence";
}

function AgentWorkOverview({
  run,
  messages,
  proposedGroups,
  settledGroups,
  additionalWork = [],
}: {
  run: RunDetail;
  messages: readonly FlueConversationMessage[];
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
  const photoCount = run.targets.filter(
    (target) => target.targetType === "image",
  ).length;
  const detail = isPhotoRun
    ? `${photoCount} ${photoCount === 1 ? "photo" : "photos"} received${settledGroups ? ` · ${settledGroups} groups settled` : ""}`
    : `${run.ordersSeen} ${run.ordersSeen === 1 ? "order" : "orders"} seen · ${run.imported} imported · ${run.updated} updated`;
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
          className="mt-3 overflow-x-auto border-t border-border pt-2"
          aria-label="Run step timing table"
        >
          <table className="w-full min-w-[760px] table-fixed border-collapse text-xs tabular-nums">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[14%]" />
              <col className="w-[15%]" />
              <col className="w-[14%]" />
              <col className="w-[13%]" />
              <col className="w-[18%]" />
            </colgroup>
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Step
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Lookups / items
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Tool / attempt
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Agent model
                </th>
                <th scope="col" className="px-2 py-2 text-right font-medium">
                  Waiting
                </th>
                <th scope="col" className="py-2 pl-2 text-right font-medium">
                  Total wall
                </th>
              </tr>
            </thead>
            <tbody>
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
                  <tr
                    key={item.kind}
                    className="border-b border-border/70 last:border-0"
                  >
                    <th scope="row" className="py-2 pr-3 text-left font-medium">
                      <span className="flex items-center gap-2">
                        <Icon
                          className={`size-3.5 shrink-0 ${item.failed && !item.completed ? "text-destructive" : item.completed ? "text-positive" : "text-muted-foreground"}`}
                          aria-hidden="true"
                        />
                        {item.label}
                      </span>
                    </th>
                    <td className="px-2 py-2 text-right text-muted-foreground">
                      {workCount(item) ?? "—"}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {toolMs === null || toolMs === undefined
                        ? "—"
                        : formatWorkDuration(toolMs)}
                    </td>
                    <td className="px-2 py-2 text-right text-muted-foreground">
                      —
                    </td>
                    <td
                      className="px-2 py-2 text-right"
                      title={
                        item.waitingMs === undefined
                          ? "No waiting interval recorded"
                          : "Photo batch wall time outside summed completed attempts; a lower bound"
                      }
                    >
                      {item.waitingMs === null || item.waitingMs === undefined
                        ? "—"
                        : `≥${formatWorkDuration(item.waitingMs)}`}
                    </td>
                    <td
                      className="py-2 pl-2 text-right"
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
                    </td>
                  </tr>
                );
              })}
              {plannedSteps.map((step) => (
                <tr
                  key={`planned-${step.kind}`}
                  className="border-b border-border/70 text-muted-foreground last:border-0"
                >
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    <span className="flex items-center gap-2">
                      <CircleIcon
                        className="size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <span>{step.label}</span>
                    </span>
                  </th>
                  <td className="px-2 py-2 text-left" colSpan={5}>
                    {step.status === "waiting_for_you"
                      ? "Waiting for your review"
                      : "Upcoming"}
                  </td>
                </tr>
              ))}
              {run.agentModelMs > 0 ? (
                <tr className="border-b border-border/70 last:border-0">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    <span className="flex items-center gap-2">
                      <CheckCircleIcon
                        className="size-3.5 shrink-0 text-positive"
                        aria-hidden="true"
                      />
                      Agent model turns
                    </span>
                  </th>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    —
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    —
                  </td>
                  <td className="px-2 py-2 text-right">
                    {formatWorkDuration(run.agentModelMs)}
                  </td>
                  <td className="px-2 py-2 text-right text-muted-foreground">
                    —
                  </td>
                  <td
                    className="py-2 pl-2 text-right"
                    title="Lower bound: measured model calls only"
                  >
                    ≥{formatWorkDuration(run.agentModelMs)}
                  </td>
                </tr>
              ) : messages.length && run.endedAt ? (
                <tr className="border-b border-border/70 last:border-0">
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    Agent model turns
                  </th>
                  <td colSpan={2} className="text-right text-muted-foreground">
                    —
                  </td>
                  <td
                    className="px-2 py-2 text-right text-muted-foreground"
                    title="No model-turn duration was stored for this run"
                  >
                    Not recorded
                  </td>
                  <td colSpan={2} className="text-right text-muted-foreground">
                    —
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
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
  messages: readonly FlueConversationMessage[];
}) {
  const review = usePhotoRunReview(run.publicId, run.status);
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
  messages: readonly FlueConversationMessage[];
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
  messages: FlueConversationMessage[];
  settlements: Array<{ submissionId: string; outcome: string }>;
}) {
  return (
    <details className="border-t border-border pt-2">
      <summary className="cursor-pointer text-sm font-medium">
        Agent messages and tool calls · {messages.length} messages
      </summary>
      <FlueTranscript messages={messages} settlements={settlements} />
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

/** Timestamped rows, newest or oldest first as the caller orders them. */
function TimedRows({
  label,
  rows,
  className = "max-h-[32rem]",
}: {
  label: string;
  rows: ReadonlyArray<{ key: string; at: string; body: ReactNode }>;
  className?: string;
}) {
  return (
    <div className={cn("overflow-auto", className)} aria-label={label}>
      {rows.map((row) => (
        <div
          key={row.key}
          className="grid gap-1 border-b border-border py-2 last:border-0 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-2"
        >
          <time
            className="font-mono text-xs text-muted-foreground"
            dateTime={row.at}
          >
            {new Date(row.at).toISOString()}
          </time>
          <div className="min-w-0">{row.body}</div>
        </div>
      ))}
    </div>
  );
}

const memberName = (member: RunDetail["actor"]) =>
  member.name ?? member.ledgerParty?.name ?? "Household member";

function RunProgress({ run }: { run: RunDetail }) {
  return (
    <Section
      title="Run progress"
      description={
        run.latestProgress ? (
          <ShortcodeProse>{`${run.latestProgress.phase}${run.latestProgress.detail ? ` · ${run.latestProgress.detail}` : ""}`}</ShortcodeProse>
        ) : (
          "No progress updates have been recorded."
        )
      }
    >
      {run.controllingMembers.length ? (
        <p className="text-sm text-muted-foreground">
          Controlled by {run.controllingMembers.map(memberName).join(", ")}.
        </p>
      ) : null}
      {run.controlHistory.length ? (
        <TimedRows
          label="Control history"
          className="max-h-60"
          rows={run.controlHistory.map((event) => ({
            key: `${event.action}-${event.createdAt}`,
            at: event.createdAt,
            body: (
              <p className="text-sm">
                <span className="font-medium">{memberName(event)}</span>{" "}
                {event.action.replaceAll("_", " ")}
              </p>
            ),
          }))}
        />
      ) : null}
      {run.progress.length ? (
        <TimedRows
          label="Run progress history"
          className="max-h-[50vh]"
          rows={[...run.progress].reverse().map((progress) => ({
            key: progress.eventId,
            at: progress.createdAt,
            body: (
              <p className="text-sm">
                <ShortcodeProse>{`${progress.phase}${progress.currentItem ? ` · ${progress.currentItem}` : ""}${progress.detail ? ` · ${progress.detail}` : ""}`}</ShortcodeProse>
              </p>
            ),
          }))}
        />
      ) : null}
    </Section>
  );
}

function TerminalAgentSurface({ run }: { run: RunDetail }) {
  const client = useMemo(
    () =>
      createFlueClient({
        url: `/api/import/runs/${encodeURIComponent(run.publicId)}/agent`,
      }),
    [run.publicId],
  );
  // The Flue conversation route, not a Cubby operation.
  const history = useQuery({
    queryKey: ["flue-agent-history", run.publicId],
    queryFn: () => client.history(),
  });
  return (
    <Section
      title="Agent history"
      description="This terminal run is view-only. The complete materialized conversation remains available as durable evidence."
    >
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
  const [prompt, setPrompt] = useState("");
  const queryClient = useQueryClient();
  const client = useMemo(
    () =>
      createFlueClient({
        url: `/api/import/runs/${encodeURIComponent(run.publicId)}/agent`,
      }),
    [run.publicId],
  );
  const observation = useMemo(() => client.observe({ live: "sse" }), [client]);
  useEffect(() => () => observation.close(), [observation]);
  const agent = useSyncExternalStore(
    observation.subscribe,
    observation.getSnapshot,
    () => EMPTY_AGENT_SNAPSHOT,
  );
  useAbsentAgentRefresh(agent.phase, run.dispatch?.eventId, observation);
  const promptMutation = useMutation({
    mutationFn: async (value: string) =>
      await client.send({
        message: { kind: "user", body: value },
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: () => {
      setPrompt("");
      observation.refresh();
    },
  });
  const abortMutation = useMutation({
    mutationFn: async () => await client.abort(),
    onSuccess: () => {
      observation.refresh();
      void invalidateOperationTags(queryClient, ripple.runOnly);
    },
  });
  const messages = agent.conversation?.messages ?? [];

  return (
    <Section
      title={
        <Row gap="sm" align="center">
          Live agent
          <Badge variant={agent.phase === "live" ? "positive" : "secondary"}>
            {agent.phase}
          </Badge>
        </Row>
      }
      description="The durable operation timeline is below; this conversation stays current through the agent stream."
    >
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

function FlueTranscript({
  messages,
  settlements,
}: {
  messages: FlueConversationMessage[];
  settlements: Array<{ submissionId: string; outcome: string }>;
}) {
  if (messages.length === 0 && settlements.length === 0)
    return <StatusText>No agent messages have been recorded yet.</StatusText>;
  return (
    <div
      className="max-h-[70vh] overflow-auto border-t border-border pt-2"
      aria-label="Agent conversation transcript"
    >
      {messages.map((message) => (
        <FlueMessage key={message.id} message={message} />
      ))}
      {settlements.map((settlement) => (
        <p
          key={settlement.submissionId}
          className="border-t border-border py-2 font-mono text-xs text-muted-foreground"
        >
          {settlement.submissionId} · {settlement.outcome}
        </p>
      ))}
    </div>
  );
}

function FlueMessage({ message }: { message: FlueConversationMessage }) {
  return (
    <article className="grid gap-1 border-b border-border py-2 last:border-0">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={message.role === "assistant" ? "default" : "outline"}>
          {message.purpose}
        </Badge>
        <span className="text-xs text-muted-foreground">{message.display}</span>
        {message.settlement ? (
          <Badge variant={statusBadgeVariant(message.settlement.outcome)}>
            {message.settlement.outcome}
          </Badge>
        ) : null}
      </div>
      {message.signal ? (
        <p className="font-mono text-xs text-muted-foreground">
          {message.signal.tagName ?? "signal"}
          {message.signal.attributes
            ? ` · ${Object.entries(message.signal.attributes)
                .map(([key, value]) => `${key}=${value}`)
                .join(" ")}`
            : ""}
        </p>
      ) : null}
      <div className="grid gap-2">
        {message.parts.map((part) => (
          <FluePart
            key={`${message.id}:${part.type}:${JSON.stringify(part)}`}
            part={part}
          />
        ))}
      </div>
    </article>
  );
}

function FluePart({ part }: { part: FlueConversationPart }) {
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
    return part.url ? (
      <a className="text-sm text-primary hover:underline" href={part.url}>
        {part.filename ?? "Agent attachment"}
      </a>
    ) : (
      <span className="text-sm text-muted-foreground">
        {part.filename ?? "Agent attachment"}
      </span>
    );
  }
  if (part.type === "dynamic-tool") {
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
  return (
    <pre className="overflow-auto bg-muted p-2 font-mono text-xs">
      {JSON.stringify(part.data, null, 2)}
    </pre>
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

function RunTimeline({ run }: { run: RunDetail }) {
  return (
    <Section
      title="Durable transcript"
      description="Oldest first. System and Mac events are retained as structured operation evidence; sensitive page content and credentials are excluded."
    >
      {run.operations.length > 0 ? (
        <TimedRows
          label="Import run transcript"
          rows={run.operations.map((operation) => ({
            key: operation.operationId,
            at: operation.startedAt,
            body: (
              <>
                <Row wrap gap="sm" align="center">
                  <code className="text-xs">{operation.kind}</code>
                  <Badge variant={statusBadgeVariant(operation.state)}>
                    {operation.state}
                  </Badge>
                </Row>
                <p className="font-mono text-xs break-all text-muted-foreground">
                  {operation.operationId}
                </p>
                {operation.error ? (
                  <p className="text-sm text-destructive">{operation.error}</p>
                ) : null}
              </>
            ),
          }))}
        />
      ) : (
        <StatusText>
          No durable operations have been recorded for this run.
        </StatusText>
      )}
    </Section>
  );
}

/** One titled list of run records, or its empty copy. */
function RunRecordList<T>({
  title,
  description,
  items,
  empty,
  render,
}: {
  title: string;
  description?: string;
  items: readonly T[];
  empty: string;
  render: (item: T) => { key: string; body: ReactNode };
}) {
  return (
    <Section title={title} description={description}>
      {items.length ? (
        <Stack gap="sm">
          {items.map((item) => {
            const row = render(item);
            return (
              <article
                key={row.key}
                className="grid gap-1 border-b border-border pb-2 text-sm last:border-0 last:pb-0"
              >
                {row.body}
              </article>
            );
          })}
        </Stack>
      ) : (
        <StatusText>{empty}</StatusText>
      )}
    </Section>
  );
}

function RunDebugLog({
  runId,
  active,
}: {
  runId: RunDetail["publicId"];
  active: boolean;
}) {
  const log = useQuery({
    ...runOperations.logs.queryOptions({ runId }),
    refetchInterval: active ? 3_000 : false,
  });
  return (
    <Section
      title="System and Mac log"
      description="Structured server and browser-bridge events are retained when the agent conversation cannot explain a transition."
    >
      {log.isLoading ? <StatusText>Loading structured log…</StatusText> : null}
      {log.isError ? (
        <StatusText tone="destructive">{log.error.message}</StatusText>
      ) : null}
      {log.data?.entries.length ? (
        <TimedRows
          label="System and Mac log"
          className="max-h-80"
          rows={log.data.entries.map((entry) => ({
            key: entry.id,
            at: entry.occurredAt,
            body: (
              <>
                <Row wrap gap="sm" align="center">
                  <Badge
                    variant={
                      entry.level === "error" ? "destructive" : "outline"
                    }
                  >
                    {entry.source}
                  </Badge>
                  <code className="text-xs">{entry.event}</code>
                </Row>
                {entry.error ? (
                  <p className="text-sm text-destructive">{entry.error}</p>
                ) : null}
              </>
            ),
          }))}
        />
      ) : null}
      {log.data?.truncated ? (
        <p className="text-xs text-warning">
          This view is limited to the first 2,000 events.
        </p>
      ) : null}
    </Section>
  );
}

/**
 * The import run's live read (agent transcript, operations, evidence), polled
 * while the run is active. Both import slots share it through the cache.
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

function RunGate({
  record,
  children,
}: {
  record: RunOut;
  children: (run: RunDetail) => ReactNode;
}) {
  const runQuery = useRun(record.id);
  const queryClient = useQueryClient();
  const liveStatus = runQuery.data?.status;
  // The page's hero and fields read the Run record, not this poll: refresh
  // it once the run moves on (a control action, or the agent finishing).
  useEffect(() => {
    if (liveStatus !== undefined && liveStatus !== record.status)
      void invalidateOperationTags(queryClient, ripple.runOnly);
  }, [liveStatus, record.status, queryClient]);
  if (runQuery.isLoading) return <StatusText>Loading import run…</StatusText>;
  if (runQuery.isError)
    return <StatusText tone="destructive">{runQuery.error.message}</StatusText>;
  return runQuery.data ? children(runQuery.data) : null;
}

/** Run detail slot: the account-sync / validation / enrichment workflow. */
export function RunImportWorkflow({ record }: { record: RunOut }) {
  return <RunGate record={record}>{(run) => <RunContent run={run} />}</RunGate>;
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
          <RunProgress run={run} />
          {run.dispatch?.eventId ? <AgentSurface run={run} /> : null}
          <details className="border border-border bg-card p-4">
            <summary className="cursor-pointer font-medium">
              Timeline and system log
            </summary>
            <div className="mt-4 grid gap-4">
              <RunTimeline run={run} />
              <RunDebugLog
                runId={run.publicId}
                active={ACTIVE_RUN_STATUSES.has(run.status)}
              />
            </div>
          </details>
        </>
      )}
    </RunGate>
  );
}

function RunOperationalSections({
  run,
  placement,
}: {
  run: RunDetail;
  placement: "active" | "terminal";
}) {
  if (ACTIVE_RUN_STATUSES.has(run.status) !== (placement === "active"))
    return null;
  return (
    <>
      <RunProgress run={run} />
      <AgentSurface run={run} />
    </>
  );
}

// The operational record intentionally renders every durable evidence family
// together so terminal history cannot silently omit one during refactors. The
// run record's own fields (trigger, vendor, dispatch, lineage, runtime) render
// in the generic Run detail around this slot.
function RunContent({ run }: { run: RunDetail }) {
  return (
    <Stack gap="lg">
      <RunControls run={run} />
      <StatGrid>
        <StatTile label="Orders seen">{run.ordersSeen}</StatTile>
        <StatTile label="Imported">{run.imported}</StatTile>
        <StatTile label="Updated">{run.updated}</StatTile>
        <StatTile label="Skipped">{run.skipped}</StatTile>
      </StatGrid>

      <RunOperationalSections run={run} placement="active" />

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Purchases changed">
          {run.affectedPurchases.length > 0 ? (
            <Stack gap="sm">
              {run.affectedPurchases.map((purchase) => (
                <EntityInlineLink
                  key={purchase.shortcode}
                  entity="purchase"
                  data={{
                    id: purchase.shortcode,
                    orderId: purchase.orderId,
                    displayLabel: purchase.displayName,
                  }}
                  displayImage={null}
                />
              ))}
            </Stack>
          ) : (
            <StatusText>No purchases were changed by this run.</StatusText>
          )}
        </Section>

        <RunRecordList
          title="Approvals"
          items={run.approvals}
          empty="No approvals were required for this run."
          render={(approval) => ({
            key: approval.id,
            body: (
              <>
                <Row wrap gap="sm" align="center">
                  <Badge variant={statusBadgeVariant(approval.state)}>
                    {approval.state}
                  </Badge>
                  <code className="text-xs">{approval.operationKind}</code>
                  <code className="text-xs break-all text-muted-foreground">
                    {approval.operationId}
                  </code>
                </Row>
                <ToolValue label="Proposed arguments" value={approval.args} />
                <span className="text-xs text-muted-foreground">
                  {approval.rejectedAt
                    ? `Rejected ${formatMoment(approval.rejectedAt)}`
                    : approval.grantedAt
                      ? `Granted ${formatMoment(approval.grantedAt)}`
                      : "Awaiting explicit approval"}
                </span>
                {approval.state === "pending" ? (
                  <RunActionButtons
                    runId={run.publicId}
                    target={{
                      operationId: approval.operationId,
                      approvalId: approval.id,
                    }}
                    actions={APPROVAL_ACTIONS}
                  />
                ) : null}
              </>
            ),
          })}
        />
      </div>

      <RunRecordList
        title="Findings"
        items={run.findings}
        empty="No findings were recorded for this run."
        render={(finding) => ({
          key: finding.id,
          body: (
            <>
              <Row wrap gap="sm" align="center">
                <Badge variant={statusBadgeVariant(finding.status)}>
                  {finding.status}
                </Badge>
                <code className="text-xs">{finding.kind}</code>
                {finding.autoApplied ? (
                  <Badge variant="outline">auto-applied</Badge>
                ) : null}
              </Row>
              <p>
                <ShortcodeProse>{finding.summary}</ShortcodeProse>
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {formatMoment(finding.createdAt)}
                {finding.probability == null
                  ? ""
                  : ` · ${(finding.probability * 100).toFixed(0)}%`}
                {finding.expiresAt
                  ? ` · expires ${formatMoment(finding.expiresAt)}`
                  : ""}
              </p>
            </>
          ),
        })}
      />

      {(run.targets.length > 0 || run.evidence.length > 0) && (
        <div className="grid gap-4 xl:grid-cols-2">
          <RunRecordList
            title="Targets and outcome"
            description="The selected source and target are frozen for this run."
            items={run.targets}
            empty="No explicit targets were recorded for this account sync."
            render={(target) => ({
              key: target.id,
              body: (
                <>
                  <Row wrap gap="sm" align="center">
                    <Badge variant={statusBadgeVariant(target.state)}>
                      {target.state}
                    </Badge>
                    <span className="font-medium">
                      {target.targetName ??
                        target.targetShortcode ??
                        target.targetType}
                    </span>
                  </Row>
                  <p className="text-xs text-muted-foreground">
                    {target.sourceLabel ?? "No source selected"}
                    {target.vendorAccountLabel
                      ? ` · ${target.vendorAccountLabel}`
                      : ""}
                  </p>
                  {target.outcome ? <p>Outcome: {target.outcome}</p> : null}
                  {target.warning ? (
                    <StatusText tone="warning">{target.warning}</StatusText>
                  ) : null}
                  {target.diff !== null ? (
                    <details className="border border-border bg-muted/30 p-2 text-xs">
                      <summary className="cursor-pointer font-medium">
                        Review semantic difference
                      </summary>
                      <ToolValue label="Difference" value={target.diff} />
                    </details>
                  ) : null}
                </>
              ),
            })}
          />
          <RunRecordList
            title="Run evidence"
            description="This evidence belongs to the run. Validation does not attach it to a purchase or product."
            items={run.evidence}
            empty="No run-scoped evidence was retained."
            render={(evidence) => ({
              key: evidence.id,
              body: (
                <>
                  <span className="font-medium">
                    {evidence.filename ?? evidence.sourceKind}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {evidence.sourceKind}
                    {evidence.mediaType ? ` · ${evidence.mediaType}` : ""}
                    {evidence.checksum ? ` · ${evidence.checksum}` : ""}
                  </span>
                </>
              ),
            })}
          />
        </div>
      )}

      <RunRecordList
        title="Prepared orders"
        items={run.preparedOrders}
        empty="No orders were prepared."
        render={(order) => ({
          key: order.stableOrderId,
          body: (
            <Row wrap gap="sm" align="baseline" justify="between">
              <span>
                {order.sourceKind} ·{" "}
                <code className="text-xs">
                  {order.externalKey ?? order.stableOrderId}
                </code>
              </span>
              <span className="font-mono text-xs text-muted-foreground tabular-nums">
                {order.lineCount} lines · {formatMoment(order.preparedAt)}
              </span>
            </Row>
          ),
        })}
      />
      <RunOperationalSections run={run} placement="terminal" />
      <RunTimeline run={run} />
      <RunDebugLog
        runId={run.publicId}
        active={ACTIVE_RUN_STATUSES.has(run.status)}
      />
    </Stack>
  );
}

const APPROVAL_ACTIONS: readonly RunAction[] = [
  { action: "approve", label: "Approve import proposal" },
  { action: "reject", label: "Reject import proposal", variant: "outline" },
];

function RunLink({ label, publicId }: { label: string; publicId: string }) {
  return (
    <Row wrap gap="sm" align="center" justify="between" className="text-sm">
      <span className="text-muted-foreground">{label}</span>
      <a
        className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
        href={runHref(publicId)}
      >
        {publicId}
        <ArrowSquareOutIcon className="size-3" />
      </a>
    </Row>
  );
}
