import type { z } from "zod";

import {
  entityInspectorHealthContract,
  entityInspectorHealthSchema,
} from "~/contracts/entity-inspector-health.contract";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export { entityInspectorHealthSchema };

export type EntityInspectorHealth = z.infer<typeof entityInspectorHealthSchema>;

export const entityInspectorHealth = defineOperationDomain(
  entityInspectorHealthContract,
  {
    inspectorHealth: {
      tags: [["entity", "inspectorHealth"]],
    },
  },
);
