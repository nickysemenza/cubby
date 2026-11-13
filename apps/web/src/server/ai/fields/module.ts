/**
 * The `fields` scope's kernel module: the field Ask, the one `fields`
 * reconciler, and the machinery capability of every authored entity that
 * declares AI fill-in.
 */
import { defineModule } from "~/server/kernel/api";

import { fieldAsk } from "./ask";
import { fieldsCapabilities, fieldsReconciler } from "./reconciler";

export const fieldsKernelModule = defineModule({
  name: "fields",
  asks: [fieldAsk],
  reconcilers: [fieldsReconciler()],
  machinery: fieldsCapabilities(),
});
