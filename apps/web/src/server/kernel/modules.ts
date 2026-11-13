/**
 * Every domain module the kernel runs, one import line per module. A domain
 * adds its line here; nothing registers itself at runtime (ADR 0029 section
 * 13). This file composes domain services, so the layer rule treats it as an
 * entry point.
 */
import { fieldsKernelModule } from "~/server/ai/fields/module";
import { runKernelModule } from "~/server/domains/run/service/run-summary";
import { shipmentKernelModule } from "~/server/domains/shipment/service";

import type { DomainModule } from "./define";

export const KERNEL_MODULES: readonly DomainModule[] = [
  runKernelModule,
  shipmentKernelModule,
  fieldsKernelModule,
];
