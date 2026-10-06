import { runPurpose } from "@cubby/schemas/purchase-import";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { fromPartial } from "@total-typescript/shoehorn";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { purchaseAgentToolCatalog } from "~/server/mcp/agent-tool-catalog";
import { McpOperationContext } from "~/server/mcp/operation-context";
import { handleMcpRequest } from "~/server/mcp/server";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { requireActor } from "~/server/request-context";
import { createTestRequestContext } from "~/server/testing/request-context";

import { cubbyMcpExtension } from "./cubby-mcp";
import type { RunServices } from "./environment";

type Execute = ToolRegistration["execute"];

// The purchase agent's real MCP client, through the production HTTP handler
// (modern protocol only) with the run-scoped caller context the private
// binding attaches after verifying the agent's delegation bearer.
describe("purchase agent Cubby MCP client", () => {
  const ctx = withTestDb();

  it("negotiates the modern protocol and carries the run delegation to the tool gate", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic agent member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const run = await insertWithShortcode(ctx.db, "run", {
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Synthetic agent actor",
      actorEmail: "agent-actor@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      trigger: "manual",
      agentSessionId: "synthetic-agent-mcp-run",
      purpose: runPurpose.parse("purchase_validation"),
      status: "running",
    });
    const requests: Request[] = [];
    const services = fromPartial<RunServices>({
      mcpFetch: (request: Request) => {
        requests.push(request.clone());
        return handleMcpRequest(request, undefined, {
          token: "",
          clientId: "purchase-agent",
          scopes: [],
          extra: {
            operationContext: new McpOperationContext(
              requireActor(
                createTestRequestContext(ctx.db, {
                  auth: { userId: ctx.actor.userId },
                }),
              ),
            ),
            purchaseAgent: { runId: run.id, grantId: "synthetic-grant" },
          },
        });
      },
    });
    const extension = cubbyMcpExtension(
      purchaseAgentToolCatalog("purchase_validation"),
      () => services,
    );
    const call = (name: string, args: Parameters<Execute>[0]) => {
      const tool = extension.tools?.find(
        (candidate) => candidate.name === `mcp__cubby__${name}`,
      );
      if (!tool) throw new Error(`missing agent tool ${name}`);
      return tool.execute(
        args,
        fromPartial({}),
        fromPartial({ abortSignal: new AbortController().signal }),
      );
    };

    // A mounted read answers.
    const read = await call("entity_read", {
      action: "list",
      entity: "vendor",
    });
    expect(read.isError).toBe(false);

    // A commit outside the run's purpose is refused by the delegation gate,
    // which only sees the run when the caller context survives the transport.
    const commit = await call("purchase_import", {
      action: "commit",
      _runExecution: { runId: run.id, operationId: "commit:synthetic" },
      prepareOperationId: "prepare:synthetic",
      resolutions: [],
    });
    expect(commit.isError).toBe(true);
    expect(JSON.stringify(commit.content)).toContain(
      "forbids commit_purchase_import",
    );

    // Every exchange is modern-era: no `initialize` handshake, and each
    // request names the negotiated revision.
    const bodies = await Promise.all(requests.map((request) => request.text()));
    expect(bodies.some((body) => body.includes('"initialize"'))).toBe(false);
    expect(
      requests.map((request) => request.headers.get("mcp-protocol-version")),
    ).toEqual(requests.map(() => "2026-07-28"));
  });
});
