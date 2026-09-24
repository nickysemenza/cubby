import { z } from "zod";

import { importRunId } from "./identifier-fields";
import { importRunPurpose } from "./import-run-fields";

/** Purposes currently coordinated by the durable Flue ImportRun agent. */
export const flueImportRunPurpose = importRunPurpose.extract([
  "account_sync",
  "purchase_validation",
  "product_enrichment",
  "photo_inventory",
]);
export type FlueImportRunPurpose = z.infer<typeof flueImportRunPurpose>;

// These prefixes are persisted in ImportRun.agentSessionId and Flue Durable
// Object storage. Existing conversations must retain their original identity.
const instancePrefix = {
  account_sync: "import-run",
  purchase_validation: "import-run",
  product_enrichment: "import-run",
  photo_inventory: "photo-inventory",
} satisfies Record<FlueImportRunPurpose, string>;
const validPrefixes = new Set<string>(Object.values(instancePrefix));

export function importRunAgentIdentity(
  runId: string,
  purpose: FlueImportRunPurpose,
): string {
  return `${instancePrefix[purpose]}:${importRunId.parse(runId)}`;
}

/** Resolve only agent-owned Flue instances; other observations are ignored. */
export function importRunIdFromAgentIdentity(
  instanceId: string | undefined,
): string | undefined {
  if (!instanceId) return undefined;
  const colon = instanceId.indexOf(":");
  if (colon < 0) return undefined;
  const prefix = instanceId.slice(0, colon);
  if (!validPrefixes.has(prefix)) return undefined;
  return importRunId.safeParse(instanceId.slice(colon + 1)).data;
}
