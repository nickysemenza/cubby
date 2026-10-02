import { activityKind, activityRunId } from "@cubby/schemas/activity";
import { entityInspectorMetadata } from "@cubby/schemas/entity-manifest";
import { runTrigger } from "@cubby/schemas/run-fields";
import { z } from "zod";

import type {
  ListSearch,
  ListSlotProps,
} from "~/entity/entity-list/list-slot-types";

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
  filters: z.literal("none").optional().catch(undefined),
});

/**
 * The Run declaration's default filter, as the triggers it hides: the
 * history opens without them until the URL names a filter of its own or
 * records clearing the default (`filters=none`), like every declared list.
 */
const declaredTriggers = entityInspectorMetadata.run.list.initialFilter.flatMap(
  (filter) =>
    filter.id === "trigger" && Array.isArray(filter.value)
      ? [filter.value]
      : [],
)[0];
const shownByDefault = new Set<string>(declaredTriggers);
const hiddenByDefault = declaredTriggers
  ? runTrigger.options.filter((trigger) => !shownByDefault.has(trigger))
  : [];

function RunHistorySlot({ search, navigate }: ListSlotProps) {
  const parsed = searchSchema.parse(search);
  // Any filter the URL names (the entity's own, or the history's Work type)
  // is the person's choice of what to see; the default only opens a bare list.
  const namesFilter =
    Boolean(parsed.kind) ||
    entityInspectorMetadata.run.filterUrlKeys.some((key) =>
      Boolean(search[key]),
    );
  const hideDefault =
    hiddenByDefault.length > 0 && !namesFilter && parsed.filters !== "none";
  const filters = {
    ...parsed,
    excludeTriggers: hideDefault ? hiddenByDefault : undefined,
    hasDefaultFilter: hiddenByDefault.length > 0,
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
        // Naming a filter of your own replaces the default outright.
        if (patch.trigger !== undefined) next.filters = undefined;
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
