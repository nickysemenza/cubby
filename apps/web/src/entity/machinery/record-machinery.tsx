import { entitySchema, type Entity } from "@cubby/schemas/entity";
import {
  kernelStageLine,
  machineryCountLine,
  machineryGapSentence,
  machineryApprovalNote,
  MACHINERY_DECIDED_NOTE,
  MACHINERY_NO_GAP_LABEL,
} from "@cubby/schemas/field-envelope-presentation";
import type { Machinery } from "@cubby/schemas/kernel/machinery";
import type { KernelGapAction } from "@cubby/schemas/kernel/stage";
import { parseShortcode } from "@cubby/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { isBrowserRoutedEntity } from "~/entity/entities";
import { machinery as machineryApi } from "~/integrations/tanstack-query/generated/domains/machinery.gen";
import { formatInstant } from "~/lib/date-format";
import { MachineryPanel } from "~/ui/derived/machinery-panel";
import { ErrorDisplay } from "~/ui/feedback/error-display";
import { Disclosure } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "~/ui/primitives/popover";
import { Skeleton } from "~/ui/primitives/skeleton";
import { DateDisplay } from "~/ui/values/date-display";

type MachineryRef = { entity: Entity; id: string; field?: string };

/** The record's machinery read; `data.machinery` is null without a capability. */
export function useMachinery(ref: MachineryRef, enabled = true) {
  return useQuery({
    ...machineryApi.read.queryOptions({
      entity: ref.entity,
      id: ref.id,
      ...(ref.field ? { field: ref.field } : {}),
    }),
    enabled,
  });
}

/** Decisions and drift approval for one record, through `machinery.decide`. */
export function useMachineryActions(ref: MachineryRef) {
  const decide = useMutation(machineryApi.decide.mutationOptions());
  const approve = useMutation(machineryApi.approveDrift.mutationOptions());
  return {
    pending: decide.isPending || approve.isPending,
    decided:
      decide.isSuccess || (approve.isSuccess && approve.data.applied > 0),
    notice: approve.isSuccess
      ? machineryApprovalNote(approve.data)
      : decide.isSuccess
        ? MACHINERY_DECIDED_NOTE
        : null,
    error: decide.error ?? approve.error,
    retry: () => {
      if (approve.error && approve.variables) approve.mutate(approve.variables);
      else if (decide.variables) decide.mutate(decide.variables);
    },
    act: (action: KernelGapAction) =>
      decide.mutate({
        entity: ref.entity,
        id: ref.id,
        decisions: [
          {
            channel: action.channel,
            kind: action.kind,
            subject: action.subject,
            field: action.field,
            ...(action.value === undefined ? {} : { value: action.value }),
          },
        ],
      }),
    approveDrift: (proposalHash: string, scope: "item" | "class") =>
      approve.mutate({
        entity: ref.entity,
        id: ref.id,
        proposalHash,
        scope,
      }),
  };
}

/** A source shortcode as a record link when its prefix names an entity. */
function MachinerySource({ code }: { code: string }) {
  const parsed = parseShortcode(code);
  const entity = parsed ? entitySchema.safeParse(parsed.type) : null;
  return entity?.success && isBrowserRoutedEntity(entity.data) ? (
    <EntityRefLink entity={entity.data} id={code} />
  ) : (
    <span className="font-mono">{code}</span>
  );
}

/** A queue estimate as the household's clock time. */
const etaText = (eta: string | null) =>
  eta === null ? null : formatInstant(eta, "monthDayTime");

/**
 * The stage line: `{Stage} · {waiting|working} for {input} from {actor}`, then
 * position and ETA only when the first gap's actor is a queue or time.
 */
function machineryStageText(read: Machinery): string {
  const first = read.gaps.items[0];
  const queue =
    first?.queue && first.actor !== "you"
      ? { ...first.queue, eta: etaText(first.queue.eta) }
      : null;
  return kernelStageLine({
    stage: read.stage,
    input: first?.input ?? null,
    actor: first?.actor ?? read.nextActor,
    queue,
  });
}

/** Whether the stage line already carries the first gap's input and actor. */
const stageNamesGap = (read: Machinery) =>
  read.gaps.items[0] !== undefined &&
  read.stage !== "ended" &&
  read.stage !== "done";

/** The panel with its decisions, for record or field scope. */
export function MachineryPanelFor({
  target,
  read,
  scope,
}: {
  target: MachineryRef;
  read: Machinery;
  scope: "record" | "field";
}) {
  const actions = useMachineryActions(target);
  const drift = read.drift;
  return (
    <div className="grid gap-2">
      <MachineryPanel
        read={read}
        scope={scope}
        renderSource={(code) => <MachinerySource code={code} />}
        onAction={actions.act}
        onApproveDrift={
          drift
            ? (driftScope) =>
                actions.approveDrift(drift.proposalHash, driftScope)
            : undefined
        }
        pending={actions.pending}
      />
      {scope === "record" ? <MachineryFacts read={read} /> : null}
      {/* Rendered before it changes so assistive tech announces it; the value
          changes only when the scope reruns. */}
      <output className="text-xs text-muted-foreground">
        {actions.notice}
      </output>
      {actions.error ? (
        <ErrorDisplay
          error={actions.error}
          title="this decision"
          onRetry={actions.retry}
        />
      ) : null}
    </div>
  );
}

/**
 * The detail header's three lines for a record with machinery (ADR 0029
 * section 10): the stage line; the first gap as one sentence with its single
 * action; a count line that opens the panel. Lines wrap, never truncate.
 */
function MachineryHeader({
  target,
  read,
}: {
  target: MachineryRef;
  read: Machinery;
}) {
  const actions = useMachineryActions(target);
  const first = read.gaps.items[0];
  const action = first?.actions.length === 1 ? first.actions[0] : null;
  return (
    <div
      data-machinery-header
      className="grid min-w-0 gap-1 py-2 text-sm break-words"
    >
      <p className="font-medium text-foreground-strong">
        {machineryStageText(read)}
      </p>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-muted-foreground">
        {/* The stage line already names the first gap; this line adds only
            when it started and its one action. */}
        <span>
          {!first ? (
            MACHINERY_NO_GAP_LABEL
          ) : stageNamesGap(read) ? (
            first.since ? (
              <>
                Since <DateDisplay timestamp={first.since} />
              </>
            ) : null
          ) : (
            machineryGapSentence(first)
          )}
        </span>
        {action ? (
          <Button
            size="xs"
            variant="outline"
            disabled={actions.pending}
            onClick={() => actions.act(action)}
          >
            {action.label}
          </Button>
        ) : null}
      </p>
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="link"
              size="xs"
              className="h-auto justify-self-start p-0 font-mono text-xs text-muted-foreground tabular-nums"
            />
          }
        >
          {machineryCountLine(read)}
        </PopoverTrigger>
        <PopoverContent className="max-h-[min(42rem,85dvh,var(--available-height))] w-[min(28rem,calc(100vw-1rem))] overflow-y-auto overscroll-contain p-3">
          <PopoverTitle className="pb-2 text-sm font-semibold">
            {machineryStageText(read)}
          </PopoverTitle>
          <MachineryPanelFor target={target} read={read} scope="record" />
        </PopoverContent>
      </Popover>
      {/* Rendered before it changes so assistive tech announces it; the value
          changes only when the scope reruns. */}
      <output className="text-xs text-muted-foreground">
        {actions.notice}
      </output>
      {actions.error ? (
        <ErrorDisplay
          error={actions.error}
          title="this decision"
          onRetry={actions.retry}
        />
      ) : null}
    </div>
  );
}

/**
 * The declared state badge beside the title, kept only while the record's
 * entity has no machinery capability: with one, the stage line replaces it.
 */
export function MachineryStateFallback({
  entity,
  id,
  children,
}: {
  entity: Entity;
  id: string;
  children: ReactNode;
}) {
  const read = useMachinery({ entity, id });
  return read.isSuccess && read.data.machinery === null ? (
    <>{children}</>
  ) : null;
}

/**
 * The detail header's machinery lines, for an entity with the capability;
 * nothing otherwise. A failed read shows its raw error and Retry.
 */
export function RecordMachineryHeader({
  entity,
  id,
}: {
  entity: Entity;
  id: string;
}) {
  const target = { entity, id };
  const read = useMachinery(target);
  if (read.isPending) return <Skeleton className="my-2 h-16 w-full" />;
  if (read.isError)
    return (
      <ErrorDisplay
        className="py-2"
        error={read.error}
        title="this record's machinery"
        onRetry={() => void read.refetch()}
      />
    );
  if (!read.data.machinery) return null;
  return <MachineryHeader target={target} read={read.data.machinery} />;
}

/** Existing scope and producer facts, without a second execution log. */
function MachineryFacts({ read }: { read: Machinery }) {
  return (
    <Disclosure summary="Worker diagnostics">
      <div className="grid gap-2 text-xs">
        {read.scopes.map((scope) => (
          <div key={`${scope.kind}:${scope.key}`}>
            <p>
              {scope.kind} · {scope.attempts} attempts ·{" "}
              {scope.durationMs == null
                ? "Duration unknown"
                : `${scope.durationMs} ms`}
            </p>
            <p>
              Last reconciled: {scope.reconciledAt ?? "Not reconciled yet"} ·
              Next attempt: {scope.nextAt ?? "None"}
            </p>
            {scope.error ? (
              <pre className="break-words whitespace-pre-wrap">
                {scope.error.class}: {scope.error.raw}
              </pre>
            ) : null}
          </div>
        ))}
        {read.asks.map((ask) => (
          <div key={ask.inputHash}>
            <p>
              {ask.feature} · {ask.attempts} attempts · Next attempt:{" "}
              {ask.nextAt}
            </p>
            <p>
              Sent: {ask.sentAt ?? "Not sent"} · Answered:{" "}
              {ask.answeredAt ?? "Not answered"}
            </p>
            {ask.lastError ? (
              <pre className="break-words whitespace-pre-wrap">
                Ask: {ask.lastError}
              </pre>
            ) : null}
          </div>
        ))}
        {read.passes?.map((pass) => (
          <div key={`${pass.name}:${pass.key}`}>
            <p>
              {pass.name} · {pass.attempts} attempts ·{" "}
              {pass.durationMs == null
                ? "Duration unknown"
                : `${pass.durationMs} ms`}
            </p>
            <p>
              Updated: {pass.updatedAt ?? "Unknown"} · Next attempt:{" "}
              {pass.availableAt}
            </p>
            {pass.lastError ? (
              <pre className="break-words whitespace-pre-wrap">
                Pass: {pass.lastError}
              </pre>
            ) : null}
          </div>
        ))}
      </div>
    </Disclosure>
  );
}

/** Diagnostic section on Image and Location beside their processing and analysis surfaces. */
export function RecordWorkerFacts({
  entity,
  id,
}: {
  entity: Entity;
  id: string;
}) {
  const read = useMachinery({ entity, id });
  if (read.isError)
    return (
      <ErrorDisplay
        error={read.error}
        title="worker diagnostics"
        onRetry={() => void read.refetch()}
      />
    );
  return read.data?.machinery ? (
    <MachineryFacts read={read.data.machinery} />
  ) : null;
}
