import { dataCheckLabel, isDefectDataCheck } from "@cubby/schemas/data-quality";
import type {
  WorkQueueGap,
  WorkQueueMember,
  WorkWaitingFor,
  WorkExplanation,
} from "@cubby/schemas/work-queue";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { ChipCluster } from "~/ui/common/chip-cluster";
import { Button } from "~/ui/primitives/button";
import { EnumPill } from "~/ui/primitives/enum-pill";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

const WORK_EXECUTOR_LABELS = {
  automatic: "Cubby / Pi",
  agent_session: "Claude / Codex",
  human: "Member",
  unknown: "Executor not yet established",
} satisfies Record<WorkExplanation["executor"], string>;

export function WorkActionDetails({
  explanations,
}: {
  explanations: WorkExplanation[];
}) {
  if (explanations.length === 0) return null;
  // Virtualized queue rows have fixed heights; expanded content lives outside them.
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Action details"
            className="shrink-0 max-md:min-h-11"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ")
                event.stopPropagation();
            }}
          />
        }
      >
        Details
      </PopoverTrigger>
      <PopoverContent
        aria-label="Action details"
        align="start"
        className="max-h-96 w-96 max-w-[calc(100vw-2rem)] overflow-y-auto text-sm"
        onClick={(event) => event.stopPropagation()}
      >
        <ul className="grid gap-3">
          {explanations.map((action) => (
            <li key={action.key} className="grid gap-1">
              <span className="font-medium">{action.label}</span>
              {action.reason !== action.label ? (
                <span>{action.reason}</span>
              ) : null}
              <span className="text-muted-foreground">
                {action.readiness} · {action.lifecycle} ·{" "}
                {WORK_EXECUTOR_LABELS[action.executor]}
              </span>
              {action.prerequisites.map((prerequisite) => (
                <span key={prerequisite.code}>
                  {prerequisite.state}: {prerequisite.reason}
                  {prerequisite.record ? (
                    <EntityRefLink
                      variant="byId"
                      entityKind={prerequisite.record.entity}
                      entityId={prerequisite.record.id}
                    />
                  ) : null}
                </span>
              ))}
              {action.effects.changes.map((change) => (
                <span
                  key={`${change.action}:${change.record?.id ?? "none"}:${change.description}`}
                >
                  {change.description}
                </span>
              ))}
              {action.effects.certainty !== "known" ? (
                <span className="text-muted-foreground">
                  {action.effects.certainty === "unknown"
                    ? "Expected changes require an operation preview."
                    : "The operation preview supplies the exact changes."}
                </span>
              ) : null}
              {action.unblocks.map((dependency) => (
                <span key={dependency.key}>
                  Unblocks: {dependency.reason}
                  {dependency.record ? (
                    <EntityRefLink
                      variant="byId"
                      entityKind={dependency.record.entity}
                      entityId={dependency.record.id}
                    />
                  ) : null}
                </span>
              ))}
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** The Waiting for filter's member roster. */
export const memberOptionsOf = (members: readonly WorkQueueMember[]) =>
  members.map((member) => ({ value: member.id, label: member.name }));

export function waitingForLabel(waitingFor: WorkWaitingFor) {
  switch (waitingFor.kind) {
    case "either":
      return "Either";
    case "unresolved":
      return "Unresolved";
    case "members":
      return waitingFor.members.map((member) => member.name).join(", ");
  }
}

export function WaitingForPill({ waitingFor }: { waitingFor: WorkWaitingFor }) {
  switch (waitingFor.kind) {
    case "either":
      return (
        <EnumPill
          icon={<UsersIcon />}
          description="Either member can do this work"
        >
          Either
        </EnumPill>
      );
    case "unresolved":
      return (
        <EnumPill
          optionRole="status"
          icon={<QuestionIcon />}
          color="var(--warning)"
          description={waitingFor.reason}
        >
          Unresolved
        </EnumPill>
      );
    case "members":
      return (
        <span className="flex min-w-0 gap-1">
          {waitingFor.members.map((member) => (
            <EntityRefLink
              key={member.id}
              variant="chip"
              entity="ledgerParty"
              id={member.id}
              name={member.name}
            />
          ))}
        </span>
      );
  }
}

/** A failed check's label; its message is the tooltip and the accessible
 * text, so the meaning never depends on hovering. */
export function GapChip({
  gap,
  dense = false,
}: {
  gap: WorkQueueGap;
  /** ChipCluster's two-line row budget assumes 12px chips. */
  dense?: boolean;
}) {
  return (
    <EnumPill
      optionRole="status"
      icon={<WarningIcon />}
      color={
        isDefectDataCheck(gap.check) ? "var(--destructive)" : "var(--warning)"
      }
      description={gap.message}
      className={dense ? "h-3 px-1 py-0 text-xs" : undefined}
    >
      {dataCheckLabel[gap.check]}
      <span className="sr-only">: {gap.message}</span>
    </EnumPill>
  );
}

const gapText = (gap: WorkQueueGap) =>
  `${dataCheckLabel[gap.check]}: ${gap.message}`;

/**
 * Table form: two chip lines inside the 32px row, then a "+N" disclosure that
 * lists every hidden check with its message. Fitting drops chips from the
 * DOM, so assistive tech reads one complete description instead of them.
 */
export function GapChipCluster({ gaps }: { gaps: readonly WorkQueueGap[] }) {
  const byCheck = new Map<string, WorkQueueGap>(
    gaps.map((gap) => [gap.check, gap]),
  );
  return (
    <span className="block min-w-0">
      <span className="sr-only">{gaps.map(gapText).join(" ")}</span>
      <ChipCluster
        items={gaps.map((gap) => ({
          key: gap.check,
          label: dataCheckLabel[gap.check],
          node: (
            <span aria-hidden className="flex max-w-full min-w-0">
              <GapChip gap={gap} dense />
            </span>
          ),
        }))}
        renderOverflow={(hidden, count) => (
          <Popover>
            <PopoverTrigger
              render={
                <button
                  type="button"
                  aria-label={`Show ${count} more checks`}
                  // The hit area extends past the glyph without widening the fit.
                  className="relative rounded-sm text-xs leading-3 text-muted-foreground tabular-nums after:absolute after:-inset-x-1.5 after:-inset-y-2 after:content-[''] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                />
              }
            >
              +{count}
            </PopoverTrigger>
            <PopoverContent side="bottom" align="start">
              <ul className="space-y-1.5">
                {hidden.map((item) => (
                  <li key={item.key}>
                    <span className="font-medium">{item.label}</span>{" "}
                    <span className="text-muted-foreground">
                      {byCheck.get(item.key)?.message}
                    </span>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}
      />
    </span>
  );
}
