import { getCloudflareContext } from "@flue/runtime/cloudflare";

import type { PurchaseImportService } from "./service";
import { purchaseImportService } from "./service";

export function serviceForCurrentRun(): PurchaseImportService {
  return purchaseImportService(getCloudflareContext().env);
}
