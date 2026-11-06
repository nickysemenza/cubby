import type { z } from "zod";

import type { entityInspectorHealthSchema } from "~/contracts/entity-inspector-health.contract";

export type EntityInspectorHealth = z.infer<typeof entityInspectorHealthSchema>;
