import { fieldsKernelModule } from "~/server/ai/fields/module";
/**
 * Every domain module the kernel runs, one import line per module. A domain
 * adds its line here; nothing registers itself at runtime (ADR 0029 section
 * 13). This file composes domain services, so the layer rule treats it as an
 * entry point.
 */
import { imageKernelModule } from "~/server/domains/image-processing/service/module";
import { connectionKernelModule } from "~/server/domains/connection/repo/connection-kernel";
import { runKernelModule } from "~/server/domains/run/service/run-summary";
import { shipmentKernelModule } from "~/server/domains/shipment/service";
import { embeddingKernelModule } from "~/server/generic/embedding/module";
import { workflowKernelModule } from "~/server/workflows/kernel-passes";

import type { DomainModule } from "./define";

export const KERNEL_MODULES: readonly DomainModule[] = [
  imageKernelModule,
  embeddingKernelModule,
  connectionKernelModule,
  runKernelModule,
  shipmentKernelModule,
  fieldsKernelModule,
  workflowKernelModule,
];
