import { imageProcessingJobKind } from "@cubby/schemas/activity";
import { z } from "zod";

import type { ListSlotProps } from "~/entity/entity-list/list-slot-types";

import { ImageJobHistory } from "./image-job-history";

const searchSchema = z.object({
  selected: z.string().optional().catch(undefined),
  kind: imageProcessingJobKind.optional().catch(undefined),
  state: z.string().optional().catch(undefined),
  attentionOnly: z.enum(["true", "false"]).optional().catch(undefined),
  subjectId: z.string().optional().catch(undefined),
  submissionId: z.string().optional().catch(undefined),
  executor: z
    .enum(["all", "cloud", "device", "unknown"])
    .optional()
    .catch(undefined),
  deviceId: z.uuid().optional().catch(undefined),
  from: z.iso.datetime().optional().catch(undefined),
  to: z.iso.datetime().optional().catch(undefined),
  // `sort` belongs to the generic Run table on the same route.
  order: z.enum(["newest", "oldest"]).optional().catch(undefined),
});

function ImageJobHistorySlot({ search, navigate }: ListSlotProps) {
  const { order, ...parsed } = searchSchema.parse(search);
  return (
    <ImageJobHistory
      filters={{
        ...parsed,
        sort: order,
        attentionOnly: parsed.attentionOnly === "true" ? true : undefined,
      }}
      onFilterChange={({ sort, ...patch }) =>
        navigate(
          Object.hasOwn(patch, "sort") || sort !== undefined
            ? { ...patch, order: sort }
            : patch,
        )
      }
      onSelect={(id) => navigate({ selected: id })}
    />
  );
}

export const runListSlots = { "image-jobs": ImageJobHistorySlot };
