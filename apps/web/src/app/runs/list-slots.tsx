import { activityKind, activityRunId } from "@cubby/schemas/activity";
import { runTrigger } from "@cubby/schemas/run-fields";
import { z } from "zod";

import type {
  ListSearch,
  ListSlotProps,
} from "~/app/_components/entity-list/list-slot-types";

import { RunHistory } from "./run-history";

const searchSchema = z.object({
  selected: activityRunId.optional().catch(undefined),
  group: z.literal("run").optional().catch(undefined),
  recordType: z.enum(["run", "image_job"]).optional().catch(undefined),
  kind: activityKind.optional().catch(undefined),
  purpose: z.string().optional().catch(undefined),
  state: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  trigger: runTrigger.optional().catch(undefined),
  vendorAccountId: z.string().optional().catch(undefined),
  vendorId: z.string().optional().catch(undefined),
  ledgerPartyId: z.string().optional().catch(undefined),
  subjectId: z.string().optional().catch(undefined),
  submissionId: z.string().optional().catch(undefined),
  executor: z
    .enum(["all", "cloud", "device", "unknown"])
    .optional()
    .catch(undefined),
  deviceId: z.uuid().optional().catch(undefined),
  from: z.iso.datetime().optional().catch(undefined),
  to: z.iso.datetime().optional().catch(undefined),
  sort: z.enum(["newest", "oldest"]).optional().catch(undefined),
});

function RunHistorySlot({ search, navigate }: ListSlotProps) {
  const parsed = searchSchema.parse(search);
  const filters = {
    ...parsed,
    kind: parsed.kind ?? activityKind.safeParse(parsed.purpose).data,
    state: parsed.state ?? parsed.status,
  };
  return (
    <RunHistory
      filters={filters}
      onFilterChange={(patch) => {
        const next: ListSearch = { ...patch };
        if (Object.hasOwn(patch, "kind")) next.purpose = undefined;
        if (Object.hasOwn(patch, "state")) next.status = undefined;
        navigate(next);
      }}
      onSelect={(id) => navigate({ selected: id })}
      onGroupChange={(grouped) =>
        navigate({ group: grouped ? "run" : undefined })
      }
    />
  );
}

export const runListSlots = { history: RunHistorySlot };
