import type { z } from "zod";

import type { McpWorkflowCaller } from "./workflow-caller";

type UnparsedMcpCaller = Parameters<z.ZodType["parse"]>[0];
interface CallerPropertyOwner {}

type CallerMethodRoster = {
  [Domain in keyof McpWorkflowCaller]: {
    [Method in keyof McpWorkflowCaller[Domain]]: true;
  };
};

const callerMethodRoster = {
  auditLog: { list: true },
  dataQuality: { setException: true, clearException: true },
  entityIntegrity: { previewOperation: true },
  expense: { analytics: true, match: true },
  financialTransaction: { previewStatementImport: true },
  householdContribution: {
    ledger: true,
    project: true,
    suggestTransferPairs: true,
  },
  image: { attachFile: true, createFileUpload: true },
  ingredient: { recipeUsages: true, resolveOrCreate: true },
  inventory: { moveEntries: true },
  meal: {
    getPreparations: true,
    addRecipe: true,
    updateRecipe: true,
    removeRecipe: true,
    getShoppingList: true,
    savePreparation: true,
  },
  problems: {
    getFast: true,
    getCounts: true,
    getByType: true,
    getViews: true,
    getCoverage: true,
    getUpc: true,
    getTracker: true,
  },
  product: {
    externalIdCollisions: true,
    patchExternalIds: true,
    verifyImages: true,
    lookupUpc: true,
    findOrCreateByUPC: true,
    projectUses: true,
    components: true,
  },
  project: {
    resources: true,
    toolSuggestions: true,
    repointUses: true,
    dashboardSummary: true,
    portfolioAnalytics: true,
  },
  purchase: {
    link: true,
    split: true,
    products: true,
    reclassifyDocument: true,
  },
  recipe: {
    scrape: true,
    insertImport: true,
    getAllTags: true,
    explainCosting: true,
  },
  search: { find: true, related: true, similar: true },
  statementRow: {
    list: true,
    summary: true,
    imports: true,
    drift: true,
    record: true,
    update: true,
    delete: true,
  },
  suggestions: { getMakeable: true },
  task: { listActionable: true, summary: true },
  usda: { getByAlternateID: true },
} as const satisfies CallerMethodRoster;

function isObject(value: UnparsedMcpCaller): value is CallerPropertyOwner {
  return typeof value === "object" && value !== null;
}

function isCallable(
  value: UnparsedMcpCaller,
): value is (...args: never[]) => void {
  return typeof value === "function";
}

function ownDescriptor(
  value: CallerPropertyOwner,
  key: string,
): PropertyDescriptor | undefined {
  return Object.getOwnPropertyDescriptor(value, key);
}

export function isMcpWorkflowCaller(
  candidate: UnparsedMcpCaller,
): candidate is McpWorkflowCaller {
  if (!isObject(candidate)) return false;
  for (const [domain, methods] of Object.entries(callerMethodRoster)) {
    const group = ownDescriptor(candidate, domain)?.value;
    if (!isObject(group)) return false;
    for (const method of Object.keys(methods)) {
      if (!isCallable(ownDescriptor(group, method)?.value)) return false;
    }
  }
  return true;
}

/** Parse the in-process caller carried through the SDK's untyped authInfo bag. */
export function parseMcpWorkflowCaller(
  candidate: UnparsedMcpCaller,
): McpWorkflowCaller {
  if (!isMcpWorkflowCaller(candidate)) {
    throw new Error("Authenticated workflow caller is missing or incomplete");
  }
  return candidate;
}
