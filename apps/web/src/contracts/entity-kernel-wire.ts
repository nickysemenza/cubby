import { entityTimelineOut } from "@cubby/schemas/entity-timeline";
import { z } from "zod";

import type { OperationWire } from "~/contracts/define";

/**
 * The wire projection of the entity kernel operations (`entity.detail`,
 * `entity.list`, `entity.mutate`, `entity.timeline`): a free-form JSON object
 * in and out. The server handler parses each body with the kernel's own
 * per-entity schema, so an invalid command is still a 400 with the raw
 * issues; the Apple client reads records through the generated entity
 * manifest, so per-entity request and response types would be compile cost
 * only.
 */
export const entityKernelObject = z.looseObject({});

export const kernelRecordWire = {
  input: entityKernelObject,
  output: entityKernelObject,
} as const satisfies OperationWire;

export const kernelDetailWire = {
  ...kernelRecordWire,
  nullable: true,
} as const satisfies OperationWire;

/** Timelines share one output shape across entities, so it stays typed. */
export const kernelTimelineWire = {
  input: entityKernelObject,
  output: entityTimelineOut,
} as const satisfies OperationWire;
