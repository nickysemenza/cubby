import type { ImportRunOut } from "@cubby/schemas/import-run";
import { flueImportRunPurpose } from "@cubby/schemas/import-run-agent";
import { initiateImportRunEvidenceUploadOut } from "@cubby/schemas/purchase-import";
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

import { usePhotoRunReview } from "~/app/import-runs/photo-group-review";
import { PhotoImportRunView } from "~/app/import-runs/photo-run-detail";
import { importRunHref } from "~/app/purchases/purchase-import-links";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { StatusText } from "~/components/ui/status-text";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { readJsonOrThrow } from "~/lib/http-error";
import {
  importRunLogResponse,
  type ImportRunLogEntry,
} from "~/lib/purchase-import-debug";
import {
  importRunControlResponse,
  importRunDetailResponse,
  type ImportRunDetail,
} from "~/lib/purchase-import-run-detail";

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

const getRun = async (publicId: string): Promise<ImportRunDetail> => {
  const response = await fetch(
    `/api/import/runs/${encodeURIComponent(publicId)}`,
  );
  const data = await readJsonOrThrow(
    response,
    importRunDetailResponse,
    "Import run could not load.",
  );
  return data.run;
};

const EMPTY_AGENT_SNAPSHOT: AgentConversationObservationSnapshot = {
  conversation: undefined,
  offset: undefined,
  phase: "loading",
  error: undefined,
};

function Metadata({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className="truncate font-mono text-xs tabular-nums"
        title={value ?? undefined}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}

function RunControl({ run }: { run: ImportRunDetail }) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: async (action: "pause" | "resume" | "cancel") => {
      const response = await fetch(
        `/api/import/runs/${encodeURIComponent(run.publicId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      const data = await readJsonOrThrow(
        response,
        importRunControlResponse,
        "Run could not be updated.",
        { method: "PATCH" },
      );
      return data.run;
    },
    onSuccess: () => {
      void queryClient.refetchQueries({
        queryKey: ["purchase-import", "run", run.publicId],
      });
    },
  });
  const active = ACTIVE_RUN_STATUSES.has(run.status);
  if (!active) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => update.mutate("cancel")}
        disabled={update.isPending}
      >
        Stop run
      </Button>
      {update.isError ? (
        <StatusText tone="destructive">{update.error.message}</StatusText>
      ) : null}
    </div>
  );
}

function TerminalRunControls({ run }: { run: ImportRunDetail }) {
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: async (action: "retry" | "restart") => {
      const response = await fetch(
        `/api/import/runs/${encodeURIComponent(run.publicId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );
      return readJsonOrThrow(
        response,
        importRunControlResponse,
        "A successor run could not be created.",
        { method: "PATCH" },
      );
    },
    onSuccess: (result) => {
      if (result.successor) {
        window.location.assign(importRunHref(result.successor.publicId));
        return;
      }
      void queryClient.refetchQueries({
        queryKey: ["purchase-import", "run", run.publicId],
      });
    },
  });
  if (
    !TERMINAL_RUN_STATUSES.has(run.status) ||
    !flueImportRunPurpose.safeParse(run.purpose).success
  )
    return null;
  return (
    <div className="grid justify-items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {run.purpose !== "photo_inventory" &&
        !run.successorRunPublicId &&
        run.status !== "dispatch_failed" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => retry.mutate("retry")}
            disabled={retry.isPending}
          >
            Retry unresolved work
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          onClick={() => retry.mutate("restart")}
          disabled={retry.isPending}
        >
          Start new run with same inputs
        </Button>
      </div>
      {run.purpose === "photo_inventory" ? (
        <p className="max-w-md text-right text-xs text-muted-foreground">
          Reuses these uploaded photos and their existing image analysis. The
          agent groups them again in a separate run.
        </p>
      ) : null}
      {retry.isError ? (
        <StatusText tone="destructive">{retry.error.message}</StatusText>
      ) : null}
    </div>
  );
}

/** A committed run without Flue admission is recoverable, not silently stuck. */
function DispatchRecoveryControls({ run }: { run: ImportRunDetail }) {
  const queryClient = useQueryClient();
  const dispatch = run.dispatch;
  const action = useMutation({
    mutationFn: async (next: "retry_dispatch" | "abort") => {
      const response = await fetch(
        `/api/import/runs/${encodeURIComponent(run.publicId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: next }),
        },
      );
      const data = await readJsonOrThrow(
        response,
        importRunControlResponse,
        "Run could not be updated.",
        { method: "PATCH" },
      );
      return data.run;
    },
    onSuccess: () => {
      void queryClient.refetchQueries({
        queryKey: ["purchase-import", "run", run.publicId],
      });
    },
  });
  if (
    !dispatch ||
    dispatch.coordinatorStartedAt ||
    dispatch.state === "started"
  )
    return null;
  return (
    <div className="grid justify-items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => action.mutate("retry_dispatch")}
          disabled={
            action.isPending ||
            dispatch.error === "Awaiting manual evidence upload"
          }
        >
          Retry dispatch
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => action.mutate("abort")}
          disabled={action.isPending}
        >
          Abort
        </Button>
      </div>
      {action.isError ? (
        <StatusText tone="destructive">{action.error.message}</StatusText>
      ) : null}
    </div>
  );
}

/** A terminal validation without usable evidence is retried as an immutable successor. */
function EvidenceRecoveryControls({ run }: { run: ImportRunDetail }) {
  const action = useMutation({
    mutationFn: async (next: "upload_evidence" | "no_evidence_available") => {
      const response = await fetch(
        `/api/import/runs/${encodeURIComponent(run.publicId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: next }),
        },
      );
      return readJsonOrThrow(
        response,
        importRunControlResponse,
        "Evidence retry could not start.",
        { method: "PATCH" },
      );
    },
    onSuccess: ({ successor }) => {
      if (successor) window.location.assign(importRunHref(successor.publicId));
    },
  });
  if (
    run.purpose !== "purchase_validation" ||
    !new Set(["needs_review", "failed"]).has(run.status) ||
    !run.targets.some((target) =>
      new Set(["needs_evidence", "unavailable", "unresolved"]).has(
        target.state,
      ),
    )
  )
    return null;
  return (
    <div className="grid justify-items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => action.mutate("upload_evidence")}
          disabled={action.isPending}
        >
          Upload evidence
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => action.mutate("no_evidence_available")}
          disabled={action.isPending}
        >
          No evidence available
        </Button>
      </div>
      {action.isError ? (
        <StatusText tone="destructive">{action.error.message}</StatusText>
      ) : null}
    </div>
  );
}

function ManualEvidenceUpload({ run }: { run: ImportRunDetail }) {
  const target = run.targets.find((item) => item.state === "needs_evidence");
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!target) throw new Error("This run has no evidence target.");
      const bytes = await file.arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const checksum = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const initiated = await fetch(
        "/api/v1/purchaseImport/initiateRunEvidenceUpload",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            runId: run.publicId,
            targetId: target.id,
            kind: "manual_upload",
            contentType: file.type || "application/octet-stream",
            byteSize: file.size,
            checksum,
            filename: file.name,
            sourceMetadata: { filename: file.name },
          }),
        },
      );
      if (!initiated.ok)
        throw new Error("Evidence upload could not be staged.");
      const staged = initiateImportRunEvidenceUploadOut.parse(
        await initiated.json(),
      );
      const stored = await fetch(staged.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: bytes,
      });
      if (!stored.ok) throw new Error("Evidence bytes could not be stored.");
      const dispatched = await fetch(
        `/api/import/runs/${encodeURIComponent(run.publicId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "retry_dispatch" }),
        },
      );
      if (!dispatched.ok)
        throw new Error("Evidence was stored, but dispatch failed.");
      return importRunControlResponse.parse(await dispatched.json());
    },
    onSuccess: () => window.location.reload(),
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

function AgentSurface({ run }: { run: ImportRunDetail }) {
  if (!ACTIVE_RUN_STATUSES.has(run.status)) {
    return <TerminalAgentSurface run={run} />;
  }
  return <ActiveAgentSurface run={run} />;
}

function agentWorkHeadline(
  run: ImportRunDetail,
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
  run: ImportRunDetail;
  messages: readonly FlueConversationMessage[];
  proposedGroups?: number;
  settledGroups?: number;
  additionalWork?: AgentWorkItem[];
}) {
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
  run: ImportRunDetail;
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
  run: ImportRunDetail;
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

function RunProgress({ run }: { run: ImportRunDetail }) {
  return (
    <section className="grid gap-3 border border-border bg-card p-4">
      <div>
        <h2 className="font-medium">Run progress</h2>
        <p className="text-sm text-muted-foreground">
          {run.latestProgress
            ? `${run.latestProgress.phase}${run.latestProgress.detail ? ` · ${run.latestProgress.detail}` : ""}`
            : "No progress updates have been recorded."}
        </p>
        {run.progress.length ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {run.progress.length} updates · newest first
          </p>
        ) : null}
      </div>
      {run.controllingMembers.length ? (
        <p className="text-sm text-muted-foreground">
          Controlled by{" "}
          {run.controllingMembers
            .map(
              (member) =>
                member.name ?? member.ledgerParty?.name ?? "Household member",
            )
            .join(", ")}
          .
        </p>
      ) : null}
      {run.controlHistory.length ? (
        <div className="grid gap-1 border-t border-border pt-3 text-sm">
          <h3 className="text-xs font-medium text-muted-foreground">
            Control history
          </h3>
          {run.controlHistory.map((event) => (
            <p key={`${event.action}-${event.createdAt}`}>
              <span className="font-medium">
                {event.name ?? event.ledgerParty?.name ?? "Household member"}
              </span>{" "}
              {event.action.replaceAll("_", " ")} ·{" "}
              <time
                className="font-mono text-xs text-muted-foreground"
                dateTime={event.createdAt}
              >
                {new Date(event.createdAt).toLocaleString()}
              </time>
            </p>
          ))}
        </div>
      ) : null}
      {run.progress.length ? (
        <div
          className="max-h-[50vh] overflow-auto"
          aria-label="Run progress history"
        >
          {[...run.progress].reverse().map((progress) => (
            <div
              key={progress.eventId}
              className="grid gap-1 border-b border-border py-2 last:border-0 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-2"
            >
              <time
                className="font-mono text-xs text-muted-foreground"
                dateTime={progress.createdAt}
              >
                {new Date(progress.createdAt).toISOString()}
              </time>
              <p className="text-sm">
                {progress.phase}
                {progress.currentItem ? ` · ${progress.currentItem}` : ""}
                {progress.detail ? ` · ${progress.detail}` : ""}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function TerminalAgentSurface({ run }: { run: ImportRunDetail }) {
  const client = useMemo(
    () =>
      createFlueClient({
        url: `/api/import/runs/${encodeURIComponent(run.publicId)}/agent`,
      }),
    [run.publicId],
  );
  const history = useQuery({
    queryKey: ["purchase-import", "run-agent-history", run.publicId],
    queryFn: () => client.history(),
  });
  return (
    <section className="grid gap-3 border border-border bg-card p-4">
      <div>
        <h2 className="font-medium">Agent history</h2>
        <p className="text-sm text-muted-foreground">
          This terminal run is view-only. The complete materialized conversation
          remains available as durable evidence.
        </p>
      </div>
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
    </section>
  );
}

function ActiveAgentSurface({ run }: { run: ImportRunDetail }) {
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
      void queryClient.refetchQueries({
        queryKey: ["purchase-import", "run", run.publicId],
      });
    },
  });
  const messages = agent.conversation?.messages ?? [];

  return (
    <section className="grid gap-3 border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium">Live agent</h2>
          <p className="text-sm text-muted-foreground">
            The durable operation timeline is below; this conversation stays
            current through the agent stream.
          </p>
        </div>
        <Badge variant={agent.phase === "live" ? "positive" : "secondary"}>
          {agent.phase}
        </Badge>
      </div>
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
    </section>
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
        {part.text}
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

function RunTimeline({ run }: { run: ImportRunDetail }) {
  return (
    <section className="grid gap-3 border border-border bg-card p-4">
      <div>
        <h2 className="font-medium">Durable transcript</h2>
        <p className="text-sm text-muted-foreground">
          Oldest first. System and Mac events are retained as structured
          operation evidence; sensitive page content and credentials are
          excluded.
        </p>
      </div>
      {run.operations.length > 0 ? (
        <div
          className="max-h-[32rem] overflow-auto"
          aria-label="Import run transcript"
        >
          {run.operations.map((operation) => (
            <div
              key={operation.operationId}
              className="grid gap-1 border-b border-border py-2 last:border-0 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-2"
            >
              <time
                className="font-mono text-xs text-muted-foreground"
                dateTime={operation.startedAt}
              >
                {new Date(operation.startedAt).toISOString()}
              </time>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs">{operation.kind}</code>
                  <Badge variant={statusBadgeVariant(operation.state)}>
                    {operation.state}
                  </Badge>
                </div>
                <p className="font-mono text-xs break-all text-muted-foreground">
                  {operation.operationId}
                </p>
                {operation.error ? (
                  <p className="text-sm text-destructive">{operation.error}</p>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <StatusText>
          No durable operations have been recorded for this run.
        </StatusText>
      )}
    </section>
  );
}

function RunTargets({ run }: { run: ImportRunDetail }) {
  return (
    <section className="grid gap-3 border border-border bg-card p-4">
      <div>
        <h2 className="font-medium">Targets and outcome</h2>
        <p className="text-sm text-muted-foreground">
          The selected source and target are frozen for this run.
        </p>
      </div>
      {run.targets.length ? (
        <div className="grid gap-2">
          {run.targets.map((target) => (
            <article
              key={target.id}
              className="grid gap-1 border-b border-border pb-2 text-sm last:border-0 last:pb-0"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={statusBadgeVariant(target.state)}>
                  {target.state}
                </Badge>
                <span className="font-medium">
                  {target.targetName ??
                    target.targetShortcode ??
                    target.targetType}
                </span>
              </div>
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
            </article>
          ))}
        </div>
      ) : (
        <StatusText>
          No explicit targets were recorded for this account sync.
        </StatusText>
      )}
    </section>
  );
}

function RunEvidence({ run }: { run: ImportRunDetail }) {
  return (
    <section className="grid gap-3 border border-border bg-card p-4">
      <div>
        <h2 className="font-medium">Run evidence</h2>
        <p className="text-sm text-muted-foreground">
          This evidence belongs to the run. Validation does not attach it to a
          purchase or product.
        </p>
      </div>
      {run.evidence.length ? (
        <div className="grid gap-2">
          {run.evidence.map((evidence) => (
            <div
              key={evidence.id}
              className="grid gap-0.5 border-b border-border pb-2 text-sm last:border-0 last:pb-0"
            >
              <span className="font-medium">
                {evidence.filename ?? evidence.sourceKind}
              </span>
              <span className="text-xs text-muted-foreground">
                {evidence.sourceKind}
                {evidence.mediaType ? ` · ${evidence.mediaType}` : ""}
                {evidence.checksum ? ` · ${evidence.checksum}` : ""}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <StatusText>No run-scoped evidence was retained.</StatusText>
      )}
    </section>
  );
}

function PendingApprovalActions({
  publicId,
  operationId,
  approvalId,
}: {
  publicId: string;
  operationId: string;
  approvalId: string;
}) {
  const queryClient = useQueryClient();
  const decision = useMutation({
    mutationFn: async (action: "approve" | "reject") => {
      const response = await fetch(
        `/api/import/runs/${encodeURIComponent(publicId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, operationId, approvalId }),
        },
      );
      const data = await readJsonOrThrow(
        response,
        importRunControlResponse,
        "Approval could not be recorded.",
        { method: "PATCH" },
      );
      return data.run;
    },
    onSuccess: () => {
      void queryClient.refetchQueries({
        queryKey: ["purchase-import", "run", publicId],
      });
    },
  });
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        size="sm"
        onClick={() => decision.mutate("approve")}
        disabled={decision.isPending}
      >
        Approve import proposal
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => decision.mutate("reject")}
        disabled={decision.isPending}
      >
        Reject import proposal
      </Button>
      {decision.isError ? (
        <StatusText tone="destructive">{decision.error.message}</StatusText>
      ) : null}
    </div>
  );
}

function RunDebugLog({
  publicId,
  active,
}: {
  publicId: string;
  active: boolean;
}) {
  const log = useQuery({
    queryKey: ["purchase-import", "run-log", publicId],
    queryFn: async () => {
      const response = await fetch("/api/import/run-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicId }),
      });
      return readJsonOrThrow(
        response,
        importRunLogResponse,
        "The run log could not load.",
        { method: "POST" },
      );
    },
    refetchInterval: active ? 3_000 : false,
  });
  return (
    <section className="grid gap-3 border border-border bg-card p-4">
      <div>
        <h2 className="font-medium">System and Mac log</h2>
        <p className="text-sm text-muted-foreground">
          Structured server and browser-bridge events are retained when the
          agent conversation cannot explain a transition.
        </p>
      </div>
      {log.isLoading ? <StatusText>Loading structured log…</StatusText> : null}
      {log.isError ? (
        <StatusText tone="destructive">{log.error.message}</StatusText>
      ) : null}
      {log.data?.entries.length ? (
        <div className="max-h-80 overflow-auto" aria-label="System and Mac log">
          {log.data.entries.map((entry) => (
            <RunDebugLogEntry key={entry.id} entry={entry} />
          ))}
          {log.data.truncated ? (
            <p className="border-t border-border pt-2 text-xs text-warning">
              This view is limited to the first 2,000 events.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function RunDebugLogEntry({ entry }: { entry: ImportRunLogEntry }) {
  return (
    <div className="grid gap-1 border-b border-border py-2 last:border-0 md:grid-cols-[12rem_minmax(0,1fr)] md:gap-2">
      <time
        className="font-mono text-xs text-muted-foreground"
        dateTime={entry.occurredAt}
      >
        {new Date(entry.occurredAt).toISOString()}
      </time>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={entry.level === "error" ? "destructive" : "outline"}>
            {entry.source}
          </Badge>
          <code className="text-xs">{entry.event}</code>
        </div>
        {entry.error ? (
          <p className="text-sm text-destructive">{entry.error}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The import run's live read (agent transcript, operations, evidence), polled
 * while the run is active. Both import slots share it through the cache.
 */
function useImportRun(publicId: string) {
  return useQuery({
    queryKey: ["purchase-import", "run", publicId],
    queryFn: () => getRun(publicId),
    refetchInterval: (query) =>
      query.state.data && ACTIVE_RUN_STATUSES.has(query.state.data.status)
        ? 3_000
        : false,
  });
}

function ImportRunGate({
  record,
  children,
}: {
  record: ImportRunOut;
  children: (run: ImportRunDetail) => ReactNode;
}) {
  const runQuery = useImportRun(record.id);
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
export function RunImportWorkflow({ record }: { record: ImportRunOut }) {
  return (
    <ImportRunGate record={record}>
      {(run) => <ImportRunContent run={run} />}
    </ImportRunGate>
  );
}

/**
 * Run detail slot for an agent-proposed photo review.
 */
export function RunPhotoBatch({ record }: { record: ImportRunOut }) {
  return (
    <ImportRunGate record={record}>
      {(run) => (
        <>
          <TerminalRunControls run={run} />
          {run.dispatch?.eventId && !run.dispatch.coordinatorStartedAt ? (
            <DispatchRecoveryControls run={run} />
          ) : null}
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
                publicId={run.publicId}
                active={ACTIVE_RUN_STATUSES.has(run.status)}
              />
            </div>
          </details>
        </>
      )}
    </ImportRunGate>
  );
}

function RunOperationalSections({
  run,
  placement,
}: {
  run: ImportRunDetail;
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
// together so terminal history cannot silently omit one during refactors.
function ImportRunContent({ run }: { run: ImportRunDetail }) {
  return (
    <div className="grid gap-4">
      <section className="grid gap-4">
        <div className="flex flex-wrap items-start justify-end gap-2">
          <RunControl run={run} />
          <DispatchRecoveryControls run={run} />
          <EvidenceRecoveryControls run={run} />
          <ManualEvidenceUpload run={run} />
          <TerminalRunControls run={run} />
        </div>
        <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metadata label="Source" value={run.source?.kind ?? run.trigger} />
          <Metadata
            label="Vendor"
            value={run.source?.vendorName ?? run.vendorAccount?.label ?? null}
          />
          {run.dispatch ? (
            <Metadata
              label="Dispatch"
              value={`${run.dispatch.state} · ${run.dispatch.attempts} attempt${run.dispatch.attempts === 1 ? "" : "s"}`}
            />
          ) : null}
        </dl>
        <div className="grid grid-cols-2 border border-border sm:grid-cols-4">
          {[
            ["Orders seen", run.ordersSeen],
            ["Imported", run.imported],
            ["Updated", run.updated],
            ["Skipped", run.skipped],
          ].map(([label, value]) => (
            <div
              key={label}
              className="border-r border-b border-border p-3 last:border-r-0 lg:border-b-0"
            >
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-mono text-sm tabular-nums">{value}</dd>
            </div>
          ))}
        </div>
        {run.dispatch?.error ? (
          <StatusText tone="destructive">{run.dispatch.error}</StatusText>
        ) : null}
      </section>

      <RunOperationalSections run={run} placement="active" />

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="grid gap-3 border border-border bg-card p-4">
          <h2 className="font-medium">Run lineage and purchases</h2>
          <div className="grid gap-2 text-sm">
            <RunLink
              label="Predecessor"
              publicId={run.predecessorRunPublicId}
            />
            <RunLink
              label="Successor"
              publicId={run.successorRunPublicId ?? null}
            />
          </div>
          {run.affectedPurchases.length > 0 ? (
            <ul className="grid gap-2 border-t border-border pt-3">
              {run.affectedPurchases.map((purchase) => (
                <li
                  key={purchase.shortcode}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-sm"
                >
                  <a
                    className="text-primary hover:underline"
                    href={`/purchases/${encodeURIComponent(purchase.shortcode)}`}
                  >
                    {purchase.displayName ??
                      purchase.orderId ??
                      purchase.shortcode}
                  </a>
                  {purchase.orderId ? (
                    <span className="font-mono text-xs text-muted-foreground">
                      {purchase.orderId}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <StatusText>No purchases were changed by this run.</StatusText>
          )}
        </section>

        <section className="grid gap-3 border border-border bg-card p-4">
          <h2 className="font-medium">Approvals</h2>
          {run.approvals.length > 0 ||
          run.operations.some(
            (operation) => operation.state === "paused_approval",
          ) ? (
            <div className="grid gap-2">
              {run.approvals.map((approval) => (
                <div
                  key={approval.id}
                  className="grid gap-1 border-b border-border pb-2 text-sm last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={statusBadgeVariant(approval.state)}>
                      {approval.state}
                    </Badge>
                    <code className="text-xs">{approval.operationKind}</code>
                    <code className="text-xs break-all text-muted-foreground">
                      {approval.operationId}
                    </code>
                  </div>
                  <ToolValue label="Proposed arguments" value={approval.args} />
                  <span className="text-xs text-muted-foreground">
                    {approval.rejectedAt
                      ? `Rejected ${formatMoment(approval.rejectedAt)}`
                      : approval.grantedAt
                        ? `Granted ${formatMoment(approval.grantedAt)}`
                        : "Awaiting explicit approval"}
                  </span>
                  {approval.state === "pending" ? (
                    <PendingApprovalActions
                      publicId={run.publicId}
                      operationId={approval.operationId}
                      approvalId={approval.id}
                    />
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <StatusText>No approvals were required for this run.</StatusText>
          )}
        </section>
      </div>

      <section className="grid gap-3 border border-border bg-card p-4">
        <h2 className="font-medium">Findings</h2>
        {run.findings.length > 0 ? (
          <div className="grid gap-2">
            {run.findings.map((finding) => (
              <article
                key={finding.id}
                className="grid gap-1 border-b border-border pb-2 text-sm last:border-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={statusBadgeVariant(finding.status)}>
                    {finding.status}
                  </Badge>
                  <code className="text-xs">{finding.kind}</code>
                  {finding.autoApplied ? (
                    <Badge variant="outline">auto-applied</Badge>
                  ) : null}
                </div>
                <p>{finding.summary}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {formatMoment(finding.createdAt)}
                  {finding.probability == null
                    ? ""
                    : ` · ${(finding.probability * 100).toFixed(0)}%`}
                  {finding.expiresAt
                    ? ` · expires ${formatMoment(finding.expiresAt)}`
                    : ""}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <StatusText>No findings were recorded for this run.</StatusText>
        )}
      </section>

      {(run.targets.length > 0 || run.evidence.length > 0) && (
        <div className="grid gap-4 xl:grid-cols-2">
          <RunTargets run={run} />
          <RunEvidence run={run} />
        </div>
      )}

      <section className="grid gap-3 border border-border bg-card p-4">
        <h2 className="font-medium">Prepared orders</h2>
        {run.preparedOrders.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Source</th>
                  <th className="p-2">Order</th>
                  <th className="p-2">Lines</th>
                  <th className="p-2">Prepared</th>
                </tr>
              </thead>
              <tbody>
                {run.preparedOrders.map((order) => (
                  <tr
                    key={order.stableOrderId}
                    className="border-b border-border last:border-0"
                  >
                    <td className="p-2">{order.sourceKind}</td>
                    <td className="p-2 font-mono text-xs">
                      {order.externalKey ?? order.stableOrderId}
                    </td>
                    <td className="p-2 font-mono tabular-nums">
                      {order.lineCount}
                    </td>
                    <td className="p-2 font-mono text-xs">
                      {formatMoment(order.preparedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <StatusText>No orders were prepared.</StatusText>
        )}
      </section>
      <RunOperationalSections run={run} placement="terminal" />
      <RunTimeline run={run} />
      <RunDebugLog
        publicId={run.publicId}
        active={ACTIVE_RUN_STATUSES.has(run.status)}
      />
    </div>
  );
}

function RunLink({
  label,
  publicId,
}: {
  label: string;
  publicId: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      {publicId ? (
        <a
          className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline"
          href={importRunHref(publicId)}
        >
          {publicId}
          <ArrowSquareOutIcon className="size-3" />
        </a>
      ) : (
        <span>—</span>
      )}
    </div>
  );
}
