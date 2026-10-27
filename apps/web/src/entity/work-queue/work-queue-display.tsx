import { dataCheckLabel, isDefectDataCheck } from "@cubby/schemas/data-quality";
import type { WorkQueueGap, WorkQueueRow } from "@cubby/schemas/work-queue";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { UsersIcon } from "@phosphor-icons/react/dist/csr/Users";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { ChipCluster } from "~/ui/common/chip-cluster";
import { EnumPill } from "~/ui/primitives/enum-pill";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/ui/primitives/popover";

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
