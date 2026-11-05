import { dataCheckLabel, isDefectDataCheck } from "@cubby/schemas/data-quality";
import type { WorkQueueGap, WorkQueueRow } from "@cubby/schemas/work-queue";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { EnumPill } from "~/ui/primitives/enum-pill";

type WorkOwners = Pick<WorkQueueRow, "owners" | "shared">;

export function ownerLabel({ owners, shared }: WorkOwners) {
  if (shared) return "Anyone";
  if (owners.length === 0) return "Unresolved";
  return owners.map((owner) => owner.name).join(", ");
}

/** Who can act: anyone in the household, named members, or nobody yet. */
export function OwnerPill({ owners, shared }: WorkOwners) {
  if (shared)
    return (
      <EnumPill icon={<UsersIcon />} description="Any member can do this work">
        Anyone
      </EnumPill>
    );
  if (owners.length === 0)
    return (
      <EnumPill
        optionRole="status"
        icon={<QuestionIcon />}
        color="var(--warning)"
        description="No member is established for this work yet"
      >
        Unresolved
      </EnumPill>
    );
  return (
    <span className="flex min-w-0 gap-1">
      {owners.map((owner) => (
        <EntityRefLink
          key={owner.id}
          entity="ledgerParty"
          id={owner.id}
          name={owner.name}
        />
      ))}
    </span>
  );
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
