import { dataCheckLabel, isDefectDataCheck } from "@cubby/schemas/data-quality";
import type {
  WorkQueueGap,
  WorkQueueMember,
  WorkWaitingFor,
} from "@cubby/schemas/work-queue";

import { renderOptionCell } from "~/entity/table/column-helpers";
import { colorizeSelectOptions } from "~/lib/select-options";
import type { PickerOption } from "~/ui/combobox/picker-option";
import { ChipCluster } from "~/ui/common/chip-cluster";
import { EnumPill } from "~/ui/primitives/enum-pill";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

/** One roster, so a member keeps the same color on every queue surface. */
export const memberOptionsOf = (members: readonly WorkQueueMember[]) =>
  colorizeSelectOptions(
    members.map((member) => ({ value: member.id, label: member.name })),
  );

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

export function WaitingForPill({
  waitingFor,
  memberOptions,
}: {
  waitingFor: WorkWaitingFor;
  memberOptions: PickerOption[];
}) {
  switch (waitingFor.kind) {
    case "either":
      return (
        <EnumPill description="Either member can do this work">Either</EnumPill>
      );
    case "unresolved":
      return (
        <EnumPill color="var(--warning)" description={waitingFor.reason}>
          Unresolved
        </EnumPill>
      );
    case "members":
      return (
        <span className="flex min-w-0 gap-1">
          {waitingFor.members.map((member) => (
            <span key={member.id} className="min-w-0">
              {renderOptionCell(member.id, memberOptions)}
            </span>
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
      color={
        isDefectDataCheck(gap.check) ? "var(--destructive)" : "var(--warning)"
      }
      description={gap.message}
      className={dense ? "h-3 px-1 py-0 text-[0.6875rem]" : undefined}
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
                  className="relative rounded-sm text-[0.6875rem] leading-3 text-muted-foreground tabular-nums after:absolute after:-inset-x-1.5 after:-inset-y-2 after:content-[''] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
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
