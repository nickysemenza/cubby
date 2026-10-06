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
import {
  createKernelMcpActions,
  type McpEntityExecutor,
} from "~/server/mcp/kernel-actions";
import type { McpOperationContext } from "~/server/mcp/operation-context";

import {
  type McpRequestContext,
  type McpToolBindings,
  type McpToolRegistrationRuntime,
  registerMcpTools,
  type ToolArguments,
} from "./tools/tool-registration";

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
 * Register one single-action tool backed by an ad hoc handler, for tests of
 * the shared adapter (errors, read policy, batches, bookkeeping). The action
 * is `run`; call it as `{ action: "run", ...input }`.
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
  const bindings: McpToolBindings = {
    [config.name]: {
      readOnly: config.kind === "query",
      destructive: false,
      openWorld: false,
      actions: {
        run: {
          kind: config.kind,
          spec: { op: member, description: "Test action.", ...config.spec },
          // SAFETY: a test operation id is not in the generated registry; it
          // only keys the read-policy lookup, which defaults to "context".
          operation: fromAny("test.run"),
          run: {
            id: fromAny("test.run"),
            input: config.input,
            output: config.output,
            // SAFETY: the adapter parses input with `config.input` first.
            run: (context, input) => config.run(context, fromAny(input)),
          },
        },
      },
    },
  };
  registerMcpTools(
    server,
    bindings,
    { [config.name]: { description: "Test tool." } },
    runtime,
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
  operationContext?: McpOperationContext;
  /** The delegation a trusted purchase agent's token carries. */
  purchaseAgent?: { runId: string; grantId: string };
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

/** Run one client request through the production transport with a test-supplied context. */
async function withTestClient<T>(
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
          requestContext: {
            db: null,
            actorContext: null,
            ...requestContext,
          },
          ...extra,
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
