import { fieldsKernelModule } from "~/server/ai/fields/module";
import { connectionKernelModule } from "~/server/domains/connection/repo/connection-kernel";
import { financialTransactionKernelModule } from "~/server/domains/financial-transaction/service/financial-kernel";
/**
 * Every domain module the kernel runs, one import line per module. A domain
 * adds its line here; nothing registers itself at runtime (ADR 0029 section
 * 13). This file composes domain services, so the layer rule treats it as an
 * entry point.
 */
import { imageKernelModule } from "~/server/domains/image-processing/service/module";
import { ledgerTransferKernelModule } from "~/server/domains/ledger-transfer/repo/transfer-pair";
import { productIdentityKernelModule } from "~/server/domains/product/repo/match/product-pair-evidence";
import { orderKernelModule } from "~/server/domains/purchase-import/service/order-kernel";
import { runKernelModule } from "~/server/domains/run/service/run-summary";
import { shipmentKernelModule } from "~/server/domains/shipment/service";
import { statementKernelModule } from "~/server/domains/transaction-import/service/statement-kernel";
import { embeddingKernelModule } from "~/server/generic/embedding/module";
import { workflowKernelModule } from "~/server/workflows/kernel-passes";

import type { DomainModule } from "./define";

export const KERNEL_MODULES: readonly DomainModule[] = [
  imageKernelModule,
  embeddingKernelModule,
  connectionKernelModule,
  runKernelModule,
  shipmentKernelModule,
  financialTransactionKernelModule,
  ledgerTransferKernelModule,
  statementKernelModule,
  orderKernelModule,
  productIdentityKernelModule,
  fieldsKernelModule,
  workflowKernelModule,
];
