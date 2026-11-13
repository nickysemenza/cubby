import {
  decisionChannelLabel,
  decisionKindLabel,
  kernelActorLabel,
  MACHINERY_EMPTY_LABEL,
  MACHINERY_UNKNOWN_CALL_NOTE,
  machineryAttemptsLabel,
  machineryCostLabel,
  machineryCoverageLabel,
  machineryEtaLabel,
  machineryInputKindLabel,
  machineryInputRowStatus,
  machineryRowStatusLabel,
  type MachineryRowStatus,
} from "@cubby/schemas/field-envelope-presentation";
import type {
  Machinery,
  MachineryGap,
  MachineryInput,
} from "@cubby/schemas/kernel/machinery";
import type { KernelGapAction } from "@cubby/schemas/kernel/stage";
import type { ReactNode } from "react";

import { formatInstant } from "~/lib/date-format";
import { Disclosure } from "~/ui/layout";
import { Button } from "~/ui/primitives/button";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
} from "~/ui/text/code-block";
import { DateDisplay } from "~/ui/values/date-display";

import { SourceStack } from "./source-stack";

const instant = (iso: string) => formatInstant(iso, "monthDayTime");

const SOURCE_STATUS = {
  used: "deciding",
  skipped: "skipped",
  gap: "gap",
  blocked: "blocked",
  failed: "failed",
} as const satisfies Record<MachineryRowStatus, string>;

/** A paid call only a member can settle: its actions decide `ask:<inputHash>` (ADR 0029 section 8). */
const unknownCall = (gap: MachineryGap) =>
  gap.actions.some((action) => action.subject.startsWith("ask:"));

const gapStatus = (gap: MachineryGap): MachineryRowStatus =>
  unknownCall(gap)
    ? "blocked"
    : gap.lastError && gap.attempts && gap.attempts.n >= gap.attempts.max
      ? "failed"
      : "gap";

function Raw({ label, value }: { label: string; value: string }) {
  return (
    <CodeBlock>
      <CodeBlockHeader label={label} value={value} />
      <CodeBlockContent>{value}</CodeBlockContent>
    </CodeBlock>
  );
}

function Heading({
  children,
  coverage,
}: {
  children: ReactNode;
  coverage: { shown: number; total: number };
}) {
  const note = machineryCoverageLabel(coverage);
  return (
    <h3 className="flex flex-wrap items-baseline gap-x-2 text-xs font-medium">
      {children}
      <span className="font-mono font-normal text-muted-foreground tabular-nums">
        {note ?? coverage.total}
      </span>
    </h3>
  );
}

function GapActions({
  gap,
  onAction,
  pending,
}: {
  gap: MachineryGap;
  onAction?: (action: KernelGapAction) => void;
  pending?: boolean;
}) {
  if (!onAction || gap.actions.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {gap.actions.map((action) => (
        <Button
          key={`${action.channel}:${action.kind}:${action.subject}:${action.field ?? ""}:${JSON.stringify(action.value ?? null)}`}
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={() => onAction(action)}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}

function GapDetail({
  gap,
  onAction,
  pending,
}: {
  gap: MachineryGap;
  onAction?: (action: KernelGapAction) => void;
  pending?: boolean;
}) {
  return (
    <div className="grid gap-1.5 text-muted-foreground">
      <p>
        from {kernelActorLabel(gap.actor)}
        {gap.since ? (
          <>
            {" "}
            · since <DateDisplay timestamp={gap.since} />
          </>
        ) : null}
      </p>
      {gap.queue ? (
        <p className="tabular-nums">
          {gap.queue.position} of {gap.queue.of} in line ·{" "}
          {machineryEtaLabel(gap.queue.eta ? instant(gap.queue.eta) : null)}
        </p>
      ) : null}
      {gap.attempts ? (
        <p className="tabular-nums">
          {machineryAttemptsLabel(
            gap.attempts,
            gap.attempts.nextAt ? instant(gap.attempts.nextAt) : null,
          )}
        </p>
      ) : null}
      {unknownCall(gap) ? (
        <p className="text-foreground">{MACHINERY_UNKNOWN_CALL_NOTE}</p>
      ) : null}
      <GapActions gap={gap} onAction={onAction} pending={pending} />
      {gap.lastError?.raw ? (
        <Disclosure summary="Raw error">
          <Raw
            label={`Error · ${gap.lastError.class}`}
            value={gap.lastError.raw}
          />
        </Disclosure>
      ) : null}
    </div>
  );
}

function InputTitle({
  input,
  renderSource,
}: {
  input: MachineryInput;
  renderSource?: (code: string) => ReactNode;
}) {
  return (
    <>
      <span>{machineryInputKindLabel(input.kind)}</span>
      {input.source
        ? (renderSource?.(input.source) ?? (
            <span className="font-mono">{input.source}</span>
          ))
        : null}
      {input.decision ? (
        <span>
          {decisionChannelLabel(input.decision.channel)} ·{" "}
          {decisionKindLabel(input.decision.kind)}
        </span>
      ) : null}
      {input.by ? <span>by {input.by}</span> : null}
      {input.at ? <DateDisplay timestamp={input.at} /> : null}
    </>
  );
}

function InputDetail({ input }: { input: MachineryInput }) {
  const { answer, decision } = input;
  return (
    <>
      {decision?.supersededBy ? (
        <p className="text-muted-foreground">
          Superseded by{" "}
          <span className="font-mono">{decision.supersededBy}</span>
        </p>
      ) : null}
      {answer ? (
        <Disclosure summary="Raw">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Model</dt>
            <dd className="break-words">{answer.model ?? "None"}</dd>
            <dt className="text-muted-foreground">Tier</dt>
            <dd className="break-words">{answer.tier ?? "None"}</dd>
            <dt className="text-muted-foreground">Cost</dt>
            <dd className="font-mono tabular-nums">
              {answer.costMicros === null
                ? "None"
                : machineryCostLabel(answer.costMicros)}
            </dd>
          </dl>
          <div className="grid gap-2 pt-2">
            <Raw label="Input hash" value={answer.inputHash} />
            {answer.rawError ? (
              <Raw label="Raw error" value={answer.rawError} />
            ) : null}
          </div>
        </Disclosure>
      ) : null}
    </>
  );
}

function Drift({
  drift,
  onApproveDrift,
  pending,
}: {
  drift: NonNullable<Machinery["drift"]>;
  onApproveDrift?: (scope: "item" | "class") => void;
  pending?: boolean;
}) {
  return (
    <section
      aria-label="Drift"
      className="grid gap-2 border-t border-border pt-2"
    >
      <h3 className="text-xs font-medium">Drift</h3>
      <p className="text-xs tabular-nums">
        The current rules would change this record. Approving issues{" "}
        {drift.askCount} {drift.askCount === 1 ? "ask" : "asks"} for about{" "}
        {machineryCostLabel(drift.estimatedCostMicros)}.
      </p>
      <Raw
        label="Exact difference"
        value={JSON.stringify(drift.difference, null, 2)}
      />
      {onApproveDrift ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={pending}
            onClick={() => onApproveDrift("item")}
          >
            Approve
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={pending}
            onClick={() => onApproveDrift("class")}
          >
            Approve every change like this
          </Button>
        </div>
      ) : null}
      <Disclosure summary="Proposal">
        <div className="grid gap-2">
          <Raw label="Proposal hash" value={drift.proposalHash} />
          <Raw label="Inputs hash" value={drift.inputsHash} />
        </div>
      </Disclosure>
    </section>
  );
}

/**
 * Everything happening to one record or one field (ADR 0029 section 10):
 * every gap with its actions, every input in the order the reconciler used
 * it, then drift. Cubby's routine work sits here at the same weight as a
 * member's. Row status is always a visible word.
 */
export function MachineryPanel({
  read,
  scope,
  renderSource,
  onAction,
  onApproveDrift,
  pending,
}: {
  read: Machinery;
  scope: "record" | "field";
  renderSource?: (code: string) => ReactNode;
  onAction?: (action: KernelGapAction) => void;
  onApproveDrift?: (scope: "item" | "class") => void;
  pending?: boolean;
}) {
  const empty =
    read.gaps.total === 0 && read.inputs.total === 0 && read.drift === null;
  return (
    <section
      aria-label={scope === "field" ? "How Cubby worked this out" : "Machinery"}
      data-machinery-scope={scope}
      className="grid min-w-0 gap-3"
    >
      {empty ? (
        <p className="text-xs text-muted-foreground">{MACHINERY_EMPTY_LABEL}</p>
      ) : null}
      {read.gaps.total > 0 ? (
        <div className="grid gap-1">
          <Heading coverage={read.gaps}>Gaps</Heading>
          <SourceStack
            label="Gaps"
            rows={read.gaps.items.map((gap, index) => {
              const status = gapStatus(gap);
              return {
                key: `${index}:${gap.input}`,
                status: SOURCE_STATUS[status],
                statusLabel: machineryRowStatusLabel(status),
                title: <span className="break-words">{gap.input}</span>,
                children: (
                  <GapDetail gap={gap} onAction={onAction} pending={pending} />
                ),
              };
            })}
          />
        </div>
      ) : null}
      {read.inputs.total > 0 ? (
        <div className="grid gap-1">
          <Heading coverage={read.inputs}>Inputs</Heading>
          <SourceStack
            label="Inputs in the order Cubby used them"
            rows={read.inputs.items.map((input, index) => {
              const status = machineryInputRowStatus(input);
              return {
                key: `${index}:${input.kind}:${input.source ?? input.answer?.inputHash ?? ""}`,
                status: SOURCE_STATUS[status],
                statusLabel: machineryRowStatusLabel(status),
                title: <InputTitle input={input} renderSource={renderSource} />,
                children: <InputDetail input={input} />,
              };
            })}
          />
        </div>
      ) : null}
      {read.drift ? (
        <Drift
          drift={read.drift}
          onApproveDrift={onApproveDrift}
          pending={pending}
        />
      ) : null}
      {read.scopes.some((s) => s.error) ? (
        <Disclosure summary="Scope errors">
          <div className="grid gap-2">
            {read.scopes.flatMap((s) =>
              s.error
                ? [
                    <Raw
                      key={`${s.kind}:${s.key}`}
                      label={`${s.kind} · ${s.error.class}`}
                      value={s.error.raw}
                    />,
                  ]
                : [],
            )}
          </div>
        </Disclosure>
      ) : null}
      {read.truncated ? (
        <p className="text-xs text-muted-foreground">
          This read was cut at its size limit; later rows are not shown.
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground tabular-nums">
        Total cost {machineryCostLabel(read.totalCostMicros)}
        {read.computedAt ? (
          <>
            {" "}
            · worked out <DateDisplay timestamp={read.computedAt} />
          </>
        ) : null}
      </p>
    </section>
  );
}
