import { buildActorContext } from "@cubby/schemas/context";
import { userId } from "@cubby/schemas/identifiers";
import type {
  McpTelemetryIdentity,
  McpToolCallTelemetry,
} from "@cubby/schemas/telemetry";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { fromAny } from "@total-typescript/shoehorn";
import type { z } from "zod";

import { mutation, query } from "~/contracts/define";
import { isKernelActionRef, type McpActionSpec } from "~/contracts/mcp-define";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { MCP_TOOL_BINDINGS } from "~/server/generated/mcp-tools.gen";
import type { StartOperationHandler } from "~/server/generated/start-operation-handlers.gen";
import {
  type DeadlineBudget,
  MCP_TOOL_DEADLINE_MS,
  type Principal,
  type RunDelegation,
} from "~/server/http/authenticate";
import type { AuthenticatedRequestContext } from "~/server/http/request-context";
import {
  createKernelMcpActions,
  type McpEntityExecutor,
} from "~/server/mcp/kernel-actions";
import { observeOperation } from "~/server/observability/observed-request";
import {
  createStartOperationRunner,
  runStartOperation,
} from "~/server/operation-runtime/start-operation.server";

import {
  type McpToolBindings,
  type McpToolRegistrationRuntime,
  registerMcpTools,
  type ToolArguments,
} from "../mcp/tools/tool-registration";

type McpRequestContext = AuthenticatedRequestContext;

/**
 * The production tool bindings with the entity-kernel verbs rebuilt over
 * `execute`, for boundary tests over synthetic kernel results.
 */
export function bindingsWithKernelExecutor(
  execute: McpEntityExecutor,
): McpToolBindings {
  const kernel = createKernelMcpActions(execute);
  return Object.fromEntries(
    Object.entries(MCP_TOOL_BINDINGS).map(([name, tool]) => [
      name,
      {
        ...tool,
        actions: Object.fromEntries(
          Object.entries(tool.actions).map(
            ([action, binding]: [
              string,
              McpToolBindings[string]["actions"][string],
            ]) => {
              const op = binding.spec.op;
              return [
                action,
                "kernel" in binding && isKernelActionRef(op)
                  ? { ...binding, kernel: kernel[op.kernel] }
                  : binding,
              ];
            },
          ),
        ),
      },
    ]),
  );
}

/**
 * A registration runtime whose runner reports its calendar and freshness side
 * effects to the given spies (absent spies discard them).
 */
export function observedMcpRuntime(spies: {
  markCalendarDirty?: (reason: string) => void;
  recordDatabaseWrite?: (operation: string) => Promise<void>;
}): McpToolRegistrationRuntime {
  const recordDatabaseWrite =
    spies.recordDatabaseWrite ?? (async () => undefined);
  return {
    runStartOperation: createStartOperationRunner({
      observe: observeOperation,
      markCalendarDirty: (reason) => spies.markCalendarDirty?.(reason),
      recordDatabaseWrite,
    }),
    recordDatabaseWrite,
  };
}

/**
 * Register one single-action tool backed by an ad hoc handler, for tests of
 * the shared adapter (errors, deadlines, batches, bookkeeping). The action is
 * `run`; call it as `{ action: "run", ...input }`. The handler runs through
 * `runtime.runStartOperation` (default: the production runner) as the ad hoc
 * operation `${name}.run`, the way a generated handler runs its operation.
 */
export function registerTestTool<
  Input extends z.ZodType,
  Output extends z.ZodType,
>(
  server: McpServer,
  config: {
    name: string;
    kind: "query" | "mutation";
    input: Input;
    output: Output;
    run: (
      context: McpRequestContext & { signal: AbortSignal },
      input: z.output<Input>,
    ) => Promise<z.input<Output>>;
    spec?: Partial<Omit<McpActionSpec, "op">>;
  },
  runtime?: McpToolRegistrationRuntime,
): void {
  const member =
    config.kind === "query"
      ? query({ input: config.input, output: config.output })
      : mutation({ input: config.input, output: config.output });
  const run = runtime?.runStartOperation ?? runStartOperation;
  const handler: StartOperationHandler<z.output<Output>> = (options) =>
    run({
      operation: { id: `${config.name}.run`, kind: config.kind },
      type: config.kind,
      input: options.data,
      inputSchema: config.input,
      outputSchema: config.output,
      request: options.request,
      run: (context, input, signal) =>
        config.run({ ...context, signal }, input),
    });
  const bindings: McpToolBindings = {
    [config.name]: {
      readOnly: config.kind === "query",
      destructive: false,
      openWorld: false,
      actions: {
        run: {
          kind: config.kind,
          spec: { op: member, description: "Test action.", ...config.spec },
          // SAFETY: a test operation id is not in the generated registry; the
          // loader below is the only one that resolves it.
          operation: fromAny("test.run"),
        },
      },
    },
  };
  registerMcpTools(
    server,
    bindings,
    { [config.name]: { description: "Test tool." } },
    {
      ...runtime,
      // SAFETY: the loader map is keyed by registry ids; this test id is not one.
      loaders: fromAny({ "test.run": async () => handler }),
    },
  );
}

/** Only the members a tool under test reads; absent handles stay null. */
export type McpTestRequestContext = {
  [Key in keyof McpRequestContext]?: McpRequestContext[Key] | null;
};

type McpTestEntityKernelContext = {
  [Key in keyof EntityKernelContext]: EntityKernelContext[Key] | null;
};

interface ToolCallExtra {
  entityKernel?: McpTestEntityKernelContext;
  /** The delegation a trusted purchase agent's token carries. */
  purchaseAgent?: RunDelegation;
  /** Default: the production MCP budget. */
  budget?: DeadlineBudget | null;
  telemetry?: {
    identity: McpTelemetryIdentity;
    emit: (event: McpToolCallTelemetry) => Promise<void>;
  };
}

/**
 * A kernel context doubles as the request context for tests: contract-member
 * actions read `db`/`actorContext`/clients from the request context, kernel
 * verbs from the entity-kernel one, and a test drives both from one database.
 */
export function kernelRequestContext(
  kernel: EntityKernelContext,
): McpTestRequestContext {
  // SAFETY: every member an action handler reads in tests (`db`,
  // `actorContext`, the USDA/UPC clients, `services.recipeCosting`) is present
  // on the kernel context; absent request-only members stay undefined.
  return kernel as McpTestRequestContext;
}

const TEST_USER = userId.parse("mcp-test-user");

/**
 * The principal `authenticate(request, MCP_AUTH)` would mint for this
 * context: the entity-kernel and request contexts merged, with a synthetic
 * actor and auth when the test supplies none.
 */
export function mcpTestPrincipal(
  requestContext: McpTestRequestContext,
  extra: ToolCallExtra = {},
): Principal {
  const merged = { ...extra.entityKernel, ...requestContext };
  const actorContext =
    merged.actorContext ??
    buildActorContext(TEST_USER, "mcp", {
      runId: fromAny(extra.purchaseAgent?.runId ?? null),
    });
  return {
    channel: "mcp",
    credential: "mcp-token",
    // SAFETY: a test supplies only the members the tool under test reads.
    context: fromAny({
      // A pool-bound stand-in: the runner's after-commit work runs at once.
      db: {},
      auth: { userId: actorContext.userId, sessionId: null },
      ...merged,
      actorContext,
    }),
    client: null,
    delegation: extra.purchaseAgent ?? null,
    budget:
      extra.budget === undefined ? { ms: MCP_TOOL_DEADLINE_MS } : extra.budget,
    session: null,
    responseHeaders: new Headers(),
  };
}

/**
 * Run client requests through the production transport with a test-supplied
 * context; the transports stay open until `request` settles.
 */
export async function withTestClient<T>(
  server: McpServer,
  requestContext: McpTestRequestContext,
  extra: ToolCallExtra,
  request: (client: Client) => Promise<T>,
): Promise<T> {
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
          principal: mcpTestPrincipal(requestContext, extra),
          telemetry: extra.telemetry,
        },
      },
    });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await request(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

/** Calls a tool through the production MCP transport with a test-supplied request context. */
export async function callMcpTool(
  server: McpServer,
  toolName: string,
  args: ToolArguments,
  requestContext: McpTestRequestContext = {},
  extra: ToolCallExtra = {},
) {
  return withTestClient(server, requestContext, extra, (client) =>
    client.callTool({ name: toolName, arguments: args }),
  );
}

/** `tools/list` as a caller with this context sees it (a purchase agent's is narrowed). */
export async function listMcpTools(
  server: McpServer,
  requestContext: McpTestRequestContext = {},
  extra: ToolCallExtra = {},
) {
  return withTestClient(server, requestContext, extra, (client) =>
    client.listTools(),
  );
}
