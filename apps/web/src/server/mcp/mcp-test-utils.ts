import type {
  McpTelemetryIdentity,
  McpToolCallTelemetry,
} from "@cubby/schemas/telemetry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { EntityKernelContext } from "~/server/entity-kernel";
import type { McpOperationContext } from "~/server/mcp/operation-context";

import type { ToolArguments } from "./tools/tool-registration";
import type { McpWorkflowCaller } from "./workflow-caller";

type PartialCaller<T> = T extends (...args: infer Args) => infer Result
  ? (...args: Args) => Result
  : T extends object
    ? { [Key in keyof T]?: PartialCaller<T[Key]> }
    : T;

export type McpTestCaller = PartialCaller<McpWorkflowCaller>;

const unavailableCallerMethod = async (): Promise<never> => {
  throw new Error("Unexpected MCP caller method in test");
};

const completeCallerSection = <Section extends object>(
  unavailable: Section,
  provided: PartialCaller<Section> | undefined,
) => Object.assign({}, unavailable, provided);

const unavailableCaller = {
  auditLog: { list: unavailableCallerMethod },
  dataQuality: {
    setException: unavailableCallerMethod,
    clearException: unavailableCallerMethod,
  },
  entityIntegrity: { previewOperation: unavailableCallerMethod },
  expense: {
    analytics: unavailableCallerMethod,
    match: unavailableCallerMethod,
  },
  financialTransaction: { previewStatementImport: unavailableCallerMethod },
  householdContribution: {
    ledger: unavailableCallerMethod,
    project: unavailableCallerMethod,
    suggestTransferPairs: unavailableCallerMethod,
  },
  image: {
    attachFile: unavailableCallerMethod,
    attachExisting: unavailableCallerMethod,
    createFileUpload: unavailableCallerMethod,
  },
  ingredient: {
    recipeUsages: unavailableCallerMethod,
    resolveOrCreate: unavailableCallerMethod,
  },
  inventory: { moveEntries: unavailableCallerMethod },
  meal: {
    getNutrition: unavailableCallerMethod,
    addRecipe: unavailableCallerMethod,
    getPreparations: unavailableCallerMethod,
    updateRecipe: unavailableCallerMethod,
    removeRecipe: unavailableCallerMethod,
    savePreparation: unavailableCallerMethod,
    getShoppingList: unavailableCallerMethod,
  },
  problems: {
    getFast: unavailableCallerMethod,
    getCounts: unavailableCallerMethod,
    getByType: unavailableCallerMethod,
    getViews: unavailableCallerMethod,
    getCoverage: unavailableCallerMethod,
    getUpc: unavailableCallerMethod,
    getTracker: unavailableCallerMethod,
  },
  product: {
    resolveNames: unavailableCallerMethod,
    externalIdCollisions: unavailableCallerMethod,
    patchExternalIds: unavailableCallerMethod,
    verifyImages: unavailableCallerMethod,
    lookupUpc: unavailableCallerMethod,
    findOrCreateByUPC: unavailableCallerMethod,
    projectUses: unavailableCallerMethod,
    components: unavailableCallerMethod,
  },
  project: {
    resources: unavailableCallerMethod,
    toolSuggestions: unavailableCallerMethod,
    repointUses: unavailableCallerMethod,
    dashboardSummary: unavailableCallerMethod,
    portfolioAnalytics: unavailableCallerMethod,
  },
  purchase: {
    link: unavailableCallerMethod,
    split: unavailableCallerMethod,
    products: unavailableCallerMethod,
    reclassifyDocument: unavailableCallerMethod,
  },
  recipe: {
    scrape: unavailableCallerMethod,
    insertImport: unavailableCallerMethod,
    getAllTags: unavailableCallerMethod,
    explainCosting: unavailableCallerMethod,
  },
  search: {
    find: unavailableCallerMethod,
    related: unavailableCallerMethod,
    similar: unavailableCallerMethod,
  },
  statementRow: {
    list: unavailableCallerMethod,
    summary: unavailableCallerMethod,
    imports: unavailableCallerMethod,
    drift: unavailableCallerMethod,
    record: unavailableCallerMethod,
    update: unavailableCallerMethod,
    delete: unavailableCallerMethod,
  },
  suggestions: { getMakeable: unavailableCallerMethod },
  task: {
    listActionable: unavailableCallerMethod,
    summary: unavailableCallerMethod,
  },
  usda: { getByAlternateID: unavailableCallerMethod },
} satisfies McpWorkflowCaller;

function completeTestCaller(caller: McpTestCaller): McpWorkflowCaller {
  return {
    auditLog: { ...unavailableCaller.auditLog, ...caller.auditLog },
    dataQuality: { ...unavailableCaller.dataQuality, ...caller.dataQuality },
    entityIntegrity: {
      ...unavailableCaller.entityIntegrity,
      ...caller.entityIntegrity,
    },
    expense: { ...unavailableCaller.expense, ...caller.expense },
    financialTransaction: {
      ...unavailableCaller.financialTransaction,
      ...caller.financialTransaction,
    },
    householdContribution: {
      ...unavailableCaller.householdContribution,
      ...caller.householdContribution,
    },
    image: { ...unavailableCaller.image, ...caller.image },
    ingredient: { ...unavailableCaller.ingredient, ...caller.ingredient },
    inventory: { ...unavailableCaller.inventory, ...caller.inventory },
    meal: completeCallerSection<McpWorkflowCaller["meal"]>(
      unavailableCaller.meal,
      caller.meal,
    ),
    problems: { ...unavailableCaller.problems, ...caller.problems },
    product: { ...unavailableCaller.product, ...caller.product },
    project: { ...unavailableCaller.project, ...caller.project },
    purchase: { ...unavailableCaller.purchase, ...caller.purchase },
    recipe: { ...unavailableCaller.recipe, ...caller.recipe },
    search: { ...unavailableCaller.search, ...caller.search },
    statementRow: {
      ...unavailableCaller.statementRow,
      ...caller.statementRow,
    },
    suggestions: { ...unavailableCaller.suggestions, ...caller.suggestions },
    task: { ...unavailableCaller.task, ...caller.task },
    usda: { ...unavailableCaller.usda, ...caller.usda },
  };
}

type McpTestEntityKernelContext = {
  [Key in keyof EntityKernelContext]: EntityKernelContext[Key] | null;
};

interface ToolCallExtra {
  entityKernel?: McpTestEntityKernelContext;
  operationContext?: McpOperationContext;
  telemetry?: {
    identity: McpTelemetryIdentity;
    emit: (event: McpToolCallTelemetry) => Promise<void>;
  };
}

/** Calls a tool through the production MCP transport with only the caller port faked. */
export async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: ToolArguments,
  caller: McpTestCaller,
  extra: ToolCallExtra = {},
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });

  const send = clientTransport.send.bind(clientTransport);
  clientTransport.send = (message, options) =>
    send(message, {
      ...options,
      authInfo: {
        token: "",
        clientId: "test",
        scopes: [],
        extra: {
          caller: completeTestCaller(caller),
          ...extra,
        },
      },
    });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await client.callTool({ name: toolName, arguments: args });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}
