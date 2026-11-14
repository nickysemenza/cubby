import { modelAsks } from "~/server/ai/model-asks";
/**
 * The `fields` scope's kernel module: the field Ask, the one `fields`
 * reconciler, and the machinery capability of every authored entity that
 * declares AI fill-in.
 */
import { defineModule } from "~/server/kernel/api";

import { fieldAsk, fieldBaselineAsk } from "./ask";
import { fieldsCapabilities, fieldsReconciler } from "./reconciler";
import { photoInventoryObservation } from "./repo/photo-evidence-kind";

export const fieldsKernelModule = defineModule({
  name: "fields",
  asks: [fieldAsk, fieldBaselineAsk, ...modelAsks],
  evidence: [photoInventoryObservation],
  reconcilers: [fieldsReconciler()],
  machinery: fieldsCapabilities(),
});
