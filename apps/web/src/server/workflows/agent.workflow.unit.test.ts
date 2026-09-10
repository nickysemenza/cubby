import type { AgentStreamEvent, AgentAskInput } from "@cubby/schemas/agent";
import { testUserId } from "@cubby/schemas/testing";
import { EventType } from "@tanstack/ai";
import { beforeAll, describe, expect, it } from "vitest";

import { createRequestContext, requireActor } from "~/server/request-context";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";

import {
  askAgentStreamWorkflow,
  type AgentStreamDependencies,
} from "./agent.server";

type Resource = Awaited<ReturnType<AgentStreamDependencies["acquire"]>>;

const input: AgentAskInput = { query: "where is flour?" };

const resourceFixture = () => {
  let closeCount = 0;
  const resource: Resource = {
    tools: [],
    records: [],
    close: async () => {
      closeCount += 1;
    },
  };
  return {
    resource,
    get closeCount() {
      return closeCount;
    },
  };
};

const dependenciesFor = (
  resource: Resource,
  stream: AgentStreamDependencies["stream"],
): AgentStreamDependencies => ({
  acquire: async () => resource,
  stream,
});

let context: AuthenticatedStartOperationContext;

beforeAll(async () => {
  context = requireActor(
    await createRequestContext({
      headers: new Headers(),
      actor: {
        userId: testUserId("agent-stream-user"),
        sessionId: null,
        source: "ui",
      },
    }),
  );
});

describe("askAgentStreamWorkflow", () => {
  it("does not acquire a resource when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let acquired = false;
    const dependencies: AgentStreamDependencies = {
      acquire: async () => {
        acquired = true;
        return resourceFixture().resource;
      },
      stream: async function* () {},
    };

    await expect(
      askAgentStreamWorkflow(
        context,
        input,
        controller.signal,
        dependencies,
      ).next(),
    ).rejects.toMatchObject({ name: "WorkflowCancelledError" });
    expect(acquired).toBe(false);
  });

  it("closes after abort during acquisition", async () => {
    const fixture = resourceFixture();
    const controller = new AbortController();
    let streamed = false;
    const dependencies: AgentStreamDependencies = {
      acquire: async () => {
        controller.abort();
        return fixture.resource;
      },
      stream: async function* () {
        streamed = true;
        yield* [];
      },
    };

    await expect(
      askAgentStreamWorkflow(
        context,
        input,
        controller.signal,
        dependencies,
      ).next(),
    ).rejects.toMatchObject({ name: "WorkflowCancelledError" });
    expect(streamed).toBe(false);
    expect(fixture.closeCount).toBe(1);
  });

  it("closes when the provider fails", async () => {
    const fixture = resourceFixture();
    const dependencies = dependenciesFor(fixture.resource, async function* () {
      yield* [];
      throw new Error("provider failed");
    });

    await expect(
      (async () => {
        for await (const _event of askAgentStreamWorkflow(
          context,
          input,
          undefined,
          dependencies,
        )) {
        }
      })(),
    ).rejects.toThrow("provider failed");
    expect(fixture.closeCount).toBe(1);
  });

  it("closes when the consumer stops early", async () => {
    const fixture = resourceFixture();
    const dependencies = dependenciesFor(fixture.resource, async function* () {
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "first",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "second",
      };
    });

    const iterator = askAgentStreamWorkflow(
      context,
      input,
      undefined,
      dependencies,
    );
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: "delta", text: "first" },
    });
    await iterator.return(undefined);
    expect(fixture.closeCount).toBe(1);
  });

  it("maps provider events and emits completion in order", async () => {
    const fixture = resourceFixture();
    const dependencies = dependenciesFor(fixture.resource, async function* () {
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: "answer",
      };
      yield {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "get_entities",
        toolName: "get_entities",
      };
      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "message-1",
        delta: " complete",
      };
    });

    const events: AgentStreamEvent[] = [];
    for await (const event of askAgentStreamWorkflow(
      context,
      input,
      undefined,
      dependencies,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "delta", text: "answer" },
      { type: "tool", tool: "get_entities" },
      { type: "delta", text: " complete" },
      { type: "done", sources: [], toolCalls: [] },
    ]);
    expect(fixture.closeCount).toBe(1);
  });
});
