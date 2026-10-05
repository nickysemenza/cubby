import {
  agentProgressReport,
  deferOrderForReviewInput,
  importOrderEvidenceInput,
  issueBrowserCommandInput,
  markHistoryExpiredInput,
  purchaseAgentOperationRef,
  saveNavigationHintsInput,
  settleChargeHuntInput,
  stopForReviewInput,
} from "@cubby/schemas/purchase-agent-services";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject, ToolExecutionApi } from "@earendil-works/pi-durable";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { RunServices } from "./environment";
import { purchaseImportTools } from "./tools";

const unusedService = () => {
  throw new Error("tools only call their service when pi invokes them");
};

/** The memo surface `step` uses: a per-task key/value store. */
function fakeApi(keys: string[] = []): ToolExecutionApi {
  const memos = new Map<string, unknown>();
  // `memo(name, context)` reads; `memo(name, candidate, context)` keeps the
  // first candidate and returns whichever value was stored. Tools reach only
  // `memo` on the execution API.
  return fromPartial<ToolExecutionApi>({
    memo: async (name: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !memos.has(name)) {
        keys.push(name);
        memos.set(name, rest[0]);
      }
      return fromAny(memos.get(name));
    },
  });
}

const toolNamed = (
  name: string,
  services: () => RunServices = unusedService,
) => {
  const tool = purchaseImportTools(services).find(
    (candidate) => candidate.name === name,
  );
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
};

/** pi's own argument check: what a model call must pass before `execute`. */
const validated = (name: string, args: JsonObject) =>
  validateToolArguments(toolNamed(name), {
    type: "toolCall",
    id: "call-1",
    name,
    arguments: args,
  });

const UUID = "0b9d4c3e-7f1a-4e2b-9c8d-1a2b3c4d5e6f";

/** Every tool, called with the widest arguments its schema accepts. */
const widestArguments = (operationId: string) => ({
  claim_next_import_work: { operationId },
  extract_receipt_evidence: { operationId },
  extract_run_evidence: { operationId },
  issue_browser_command: {
    operationId,
    command: { kind: "capture_order", target: "x".repeat(500) },
  },
  read_browser_command_result: { operationId },
  import_browser_order_evidence: {
    operationId,
    commandId: UUID,
    defaultTrade: "other",
    defaultProjectId: "PRJ-4K7M",
  },
  report_agent_progress: {
    operationId,
    phase: "review",
    currentItem: "x".repeat(500),
    awaitingApproval: false,
    detail: "x".repeat(1_000),
  },
  save_navigation_hints: {
    operationId,
    hints: [
      { url: `https://shop.example.test/${"p".repeat(2_000)}`, label: "x" },
    ],
  },
  mark_history_expired: {
    operationId,
    earliestAvailableOrderAt: "2026-01-01T00:00:00Z",
  },
  finish_import_run: { operationId },
  stop_import_run_for_review: {
    operationId,
    reason: "other",
    detail: "x".repeat(1_000),
  },
  defer_order_for_review: {
    operationId,
    orderId: "x".repeat(200),
    detail: "x".repeat(1_000),
  },
  settle_charge_hunt: {
    operationId,
    huntId: UUID,
    outcome: "needs_review",
    detail: "x".repeat(1_000),
  },
});

/** The host contract each service method parses its input with. */
const hostContract = new Map<string, z.ZodType>(
  Object.entries({
    claimNextWork: purchaseAgentOperationRef,
    extractReceiptEvidence: purchaseAgentOperationRef,
    extractRunEvidence: purchaseAgentOperationRef,
    issueBrowserCommand: issueBrowserCommandInput,
    readBrowserCommandResult: purchaseAgentOperationRef,
    importOrderEvidence: importOrderEvidenceInput,
    updateAgentProgress: agentProgressReport,
    saveNavigationHints: saveNavigationHintsInput,
    markHistoryExpired: markHistoryExpiredInput,
    finishRun: purchaseAgentOperationRef,
    stopForReview: stopForReviewInput,
    deferOrderForReview: deferOrderForReviewInput,
    settleChargeHunt: settleChargeHuntInput,
  } satisfies Partial<Record<keyof RunServices, z.ZodType>>),
);

type ServiceCall = { method: string; input: JsonObject };

/** Services that record each call and answer with a completed result. */
function recordingServices(calls: ServiceCall[]): () => RunServices {
  const services = new Proxy(
    {},
    {
      get: (_target, method) => async (input: ServiceCall["input"]) => {
        calls.push({ method: String(method), input });
        return { status: "completed" };
      },
    },
  );
  return () => fromAny(services);
}

/** Run one tool the way pi does: validate the model's call, then execute. */
async function callTool(name: string, args: JsonObject) {
  const calls: ServiceCall[] = [];
  const memoKeys: string[] = [];
  const result = await toolNamed(name, recordingServices(calls)).execute(
    validated(name, args),
    fakeApi(memoKeys),
    BACKGROUND_CONTEXT,
  );
  return { calls, memoKeys, terminates: result.control?.terminate === true };
}

describe("purchase-import agent tool authority", () => {
  it("keeps model-facing RPC limited to bounded browser and run lifecycle operations", () => {
    const tools = purchaseImportTools(unusedService);
    expect(tools.map((tool) => tool.name)).toEqual([
      "claim_next_import_work",
      "extract_receipt_evidence",
      "extract_run_evidence",
      "issue_browser_command",
      "read_browser_command_result",
      "import_browser_order_evidence",
      "report_agent_progress",
      "save_navigation_hints",
      "mark_history_expired",
      "finish_import_run",
      "stop_import_run_for_review",
      "defer_order_for_review",
      "settle_charge_hunt",
    ]);
    expect(tools.every((tool) => tool.replay === "safe")).toBe(true);
  });

  // The parameter schemas are what the model sees and what pi validates its
  // calls against: a change here is a change to the agent's authority.
  it("publishes the reviewed model-visible parameter schemas", async () => {
    const schemas = Object.fromEntries(
      purchaseImportTools(unusedService).map((tool) => [
        tool.name,
        tool.parameters,
      ]),
    );
    await expect(`${JSON.stringify(schemas, null, 2)}\n`).toMatchFileSnapshot(
      "./__snapshots__/tool-parameters.snap",
    );
  });

  // Memo keys and the prefixes the tools add are persisted replay identity:
  // an evicted agent replays its tool tasks by these keys, and the host
  // dedupes by the prefixed operation and event ids.
  it("prefixes each model operation id once, with stable memo keys and termination", async () => {
    const observed = Object.fromEntries(
      await Promise.all(
        Object.entries(widestArguments("op-1")).map(async ([name, args]) => {
          const { calls, memoKeys, terminates } = await callTool(name, args);
          const ids = calls.map(({ method, input }) => [
            method,
            input.operationId ?? input.eventId,
          ]);
          return [name, { memoKeys, calls: ids, terminates }] as const;
        }),
      ),
    );
    expect(observed).toEqual({
      claim_next_import_work: {
        memoKeys: ["claim-work:op-1"],
        calls: [["claimNextWork", "op-1"]],
        terminates: false,
      },
      extract_receipt_evidence: {
        memoKeys: ["extract-receipt:op-1"],
        calls: [["extractReceiptEvidence", "op-1"]],
        terminates: false,
      },
      extract_run_evidence: {
        memoKeys: ["extract-run-evidence:op-1"],
        calls: [["extractRunEvidence", "op-1"]],
        terminates: false,
      },
      issue_browser_command: {
        memoKeys: ["browser-progress:op-1", "browser-command:op-1"],
        calls: [
          ["updateAgentProgress", "browser-progress:op-1"],
          ["issueBrowserCommand", "browser-command:op-1"],
        ],
        terminates: false,
      },
      read_browser_command_result: {
        memoKeys: [],
        calls: [["readBrowserCommandResult", "browser-command:op-1"]],
        terminates: false,
      },
      import_browser_order_evidence: {
        memoKeys: ["import-browser-evidence:op-1"],
        calls: [["importOrderEvidence", "op-1"]],
        terminates: false,
      },
      report_agent_progress: {
        memoKeys: ["agent-progress:op-1", "agent-progress-review:op-1"],
        calls: [
          ["updateAgentProgress", "agent-progress:op-1"],
          ["stopForReview", "agent-progress-review:op-1"],
        ],
        terminates: true,
      },
      save_navigation_hints: {
        memoKeys: ["navigation-hints:op-1"],
        calls: [["saveNavigationHints", "op-1"]],
        terminates: false,
      },
      mark_history_expired: {
        memoKeys: ["history-expired:op-1"],
        calls: [["markHistoryExpired", "op-1"]],
        terminates: false,
      },
      finish_import_run: {
        memoKeys: ["finish-run:op-1"],
        calls: [["finishRun", "op-1"]],
        terminates: true,
      },
      stop_import_run_for_review: {
        memoKeys: ["stop-review:op-1"],
        calls: [["stopForReview", "op-1"]],
        terminates: true,
      },
      defer_order_for_review: {
        memoKeys: ["defer-order:op-1"],
        calls: [["deferOrderForReview", "op-1"]],
        terminates: false,
      },
      settle_charge_hunt: {
        memoKeys: ["settle-charge-hunt:op-1"],
        calls: [["settleChargeHunt", "op-1"]],
        terminates: false,
      },
    });
  });

  // The model's ids are capped below the host's 256 so the longest prefix a
  // tool prepends still fits: every widest call must reach a service with an
  // input the host contract accepts.
  it("forwards only inputs the host contract accepts, even at the model's limits", async () => {
    for (const [name, args] of Object.entries(
      widestArguments("o".repeat(200)),
    )) {
      const { calls } = await callTool(name, args);
      for (const { method, input } of calls) {
        const contract = hostContract.get(method);
        if (!contract) throw new Error(`No host contract for ${method}`);
        expect(
          contract.safeParse(input).error?.issues,
          `${name} → ${method}`,
        ).toBeUndefined();
      }
      expect(() =>
        validated(name, { ...args, operationId: "o".repeat(201) }),
      ).toThrow(/operationId/);
    }
  });

  // A pending browser command must end the run so the queue event can resume
  // it, rather than leaving the coordinator polling.
  it("ends the run on a pending browser command and replays its effect once", async () => {
    const issueBrowserCommand = vi.fn(async () => ({ state: "dispatched" }));
    // The browser tool calls only these two service methods.
    const service = () =>
      fromPartial<RunServices>({
        updateAgentProgress: async () => ({ recorded: true }),
        issueBrowserCommand,
      });
    const tool = toolNamed("issue_browser_command", service);
    const api = fakeApi();
    const args = {
      operationId: "browse-1",
      command: { kind: "capture_order" as const, target: "order-1" },
    };

    const first = await tool.execute(args, api, BACKGROUND_CONTEXT);
    const replay = await tool.execute(args, api, BACKGROUND_CONTEXT);

    expect(first.control).toEqual({ terminate: true });
    expect(replay).toEqual(first);
    expect(issueBrowserCommand).toHaveBeenCalledOnce();
  });

  // Reading a browser result is deliberately not memoized: a memoized pending
  // answer would hide the completed result the resumed agent came back for.
  it("reads a browser result fresh after an earlier pending read", async () => {
    const readBrowserCommandResult = vi
      .fn<RunServices["readBrowserCommandResult"]>()
      .mockResolvedValueOnce({ state: "dispatched" })
      .mockResolvedValueOnce({ state: "completed", commandId: UUID });
    const tool = toolNamed("read_browser_command_result", () =>
      fromPartial<RunServices>({ readBrowserCommandResult }),
    );
    const api = fakeApi();
    const args = { operationId: "browse-1" };

    const pending = await tool.execute(args, api, BACKGROUND_CONTEXT);
    const ready = await tool.execute(args, api, BACKGROUND_CONTEXT);

    expect(pending.control).toEqual({ terminate: true });
    expect(ready.control).toBeUndefined();
    expect(ready.content).toEqual([
      {
        type: "text",
        text: JSON.stringify({ state: "completed", commandId: UUID }),
      },
    ]);
    expect(readBrowserCommandResult).toHaveBeenCalledTimes(2);
  });

  // pi converts a call's arguments with TypeBox before validating them, so a
  // model's `"TRUE"` or `"0"` for a boolean has always reached the host as a
  // boolean. A plain JSON Schema parameter fell back to pi's narrower
  // coercion and refused those calls.
  it("converts loosely typed scalars as TypeBox always has", () => {
    const converted = {
      boolean: [
        ["TRUE", true],
        ["False", false],
        ["true", true],
        ["1", true],
        ["0", false],
        [1, true],
        [0, false],
      ],
      number: [
        ["1", 1],
        ["2.5", 2.5],
        ["TRUE", 1],
        ["False", 0],
        [true, 1],
      ],
      integer: [
        ["1", 1],
        ["0", 0],
        ["TRUE", 1],
        [false, 0],
      ],
    } as const;
    const fields: string[] = [];
    for (const [name, args] of Object.entries(widestArguments("op-1"))) {
      const properties = z
        .record(z.string(), z.looseObject({ type: z.string().optional() }))
        .parse(
          JSON.parse(JSON.stringify(toolNamed(name).parameters)).properties,
        );
      for (const [field, { type }] of Object.entries(properties)) {
        if (type !== "boolean" && type !== "number" && type !== "integer")
          continue;
        fields.push(`${name}.${field}`);
        for (const [sent, expected] of converted[type])
          expect(
            validated(name, { ...args, [field]: sent })[field],
            `${name}.${field} = ${JSON.stringify(sent)}`,
          ).toBe(expected);
        expect(() => validated(name, { ...args, [field]: "maybe" })).toThrow(
          new RegExp(field),
        );
      }
    }
    // The matrix must reach every scalar field the tools publish.
    expect(fields).toEqual(["report_agent_progress.awaitingApproval"]);
  });

  it("rejects arbitrary browser actions and unbounded text", () => {
    for (const kind of ["open_auth", "run_script", "navigate", "submit_form"])
      expect(() =>
        validated("issue_browser_command", {
          operationId: "auth-without-evidence",
          command: { kind },
        }),
      ).toThrow(/command/);
    expect(() =>
      validated("issue_browser_command", {
        operationId: "browse-1",
        command: { kind: "capture_order", target: "x".repeat(2_049) },
      }),
    ).toThrow(/target/);
    expect(() =>
      validated("save_navigation_hints", {
        operationId: "hints-1",
        hints: [{ url: "javascript-not-a-url" }],
      }),
    ).toThrow(/url/);
    expect(() =>
      validated("report_agent_progress", {
        operationId: "progress-1",
        phase: "awaiting_approval",
        awaitingApproval: true,
        detail: "x".repeat(1_001),
      }),
    ).toThrow(/detail/);
    // The model reports only the closed phase list, not the host's open text.
    expect(() =>
      validated("report_agent_progress", {
        operationId: "progress-1",
        phase: "browsing",
      }),
    ).toThrow(/phase/);
  });
});
