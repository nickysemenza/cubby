import { dataCheckLabel, isDefectDataCheck } from "@cubby/schemas/data-quality";
import type {
  WorkQueueGap,
  WorkQueueMember,
  WorkWaitingFor,
} from "@cubby/schemas/work-queue";

import { colorizeSelectOptions } from "~/lib/select-options";
import { ChipCluster } from "~/ui/common/chip-cluster";
import { renderOptionCell } from "~/ui/data-table/columnHelpers";
import type { FilterableComboboxItem } from "~/ui/primitives/combobox";
import { EnumPill } from "~/ui/primitives/enum-pill";

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
  memberOptions: FilterableComboboxItem[];
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

/** Table form: two chip lines inside the 32px row, then "+N". */
export function GapChipCluster({ gaps }: { gaps: readonly WorkQueueGap[] }) {
  return (
    <ChipCluster
      items={gaps.map((gap) => ({
        key: gap.check,
        label: dataCheckLabel[gap.check],
        node: <GapChip gap={gap} dense />,
      }))}
    />
  );
}
