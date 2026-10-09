import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { fromAny, fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it, vi } from "vitest";

import type { RunServices } from "./environment";
import { purchaseImportTools } from "./tools";

const workRef = "0b9d4c3e-7f1a-4e2b-9c8d-1a2b3c4d5e6f";
function api(): ToolExecutionApi {
  const values = new Map<string, unknown>();
  return fromPartial<ToolExecutionApi>({
    memo: async (key: string, ...rest: unknown[]) => {
      if (rest.length === 2 && !values.has(key)) values.set(key, rest[0]);
      return fromAny(values.get(key));
    },
  });
}
function named(name: string, services: RunServices) {
  const found = purchaseImportTools(() => services).find(
    (tool) => tool.name === name,
  );
  if (!found) throw new Error(`Missing research tool ${name}`);
  return found;
}

describe("bounded research runtime", () => {
  it("retains a hidden call identity across a failed effect and terminates waiting browser work", async () => {
    const observe = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValue({ state: "waiting" });
    const tool = named(
      "work_observe",
      fromPartial<RunServices>({ researchObserve: observe }),
    );
    const execution = api();
    const args = {
      workRef,
      action: { kind: "navigate", url: "https://shop.example.test/orders" },
    };
    await expect(
      tool.execute(args, execution, BACKGROUND_CONTEXT),
    ).rejects.toThrow("lost response");
    const waiting = await tool.execute(args, execution, BACKGROUND_CONTEXT);
    expect(waiting.control).toEqual({ terminate: true });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe.mock.calls[0]?.[0]).toEqual(args);
    expect(observe.mock.calls[0]?.[1]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(observe.mock.calls[1]?.[1]).toBe(observe.mock.calls[0]?.[1]);
    expect(await tool.execute(args, execution, BACKGROUND_CONTEXT)).toEqual(
      waiting,
    );
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("passes archived resolve arguments only for an already-started durable host call", async () => {
    const proposal = {
      workRef,
      status: "verified",
      identity: { evidenceIds: [], reasoning: "Previously supported original" },
      orders: [
        {
          candidate: {
            orderId: "SYNTHETIC-ORDER",
            orderedAt: null,
            merchant: "Synthetic service",
            currency: "USD",
            printedGrandTotal: 10,
            lines: [],
            payments: [],
            allShipmentsDelivered: false,
          },
          evidenceIds: [],
          reasoning: "Supported retained receipt",
          defaultTrade: "other",
        },
      ],
      detail: "Previously committed acquisition",
    };
    const resolve = vi.fn().mockResolvedValue({ state: "done" });
    const tool = named(
      "work_resolve",
      fromPartial<RunServices>({ researchResolve: resolve }),
    );
    // pi-durable resumes execute checkpoints directly; the existing host
    // memo is proof that this tool reached the service effect previously.
    const execution = api();
    await execution.memo(
      "host-call-id",
      { value: "synthetic-resumed-call" },
      BACKGROUND_CONTEXT,
    );
    await tool.execute(proposal, execution, BACKGROUND_CONTEXT);
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        orders: [expect.objectContaining({ defaultTrade: "other" })],
      }),
      "synthetic-resumed-call",
    );
    await expect(
      tool.execute(proposal, api(), BACKGROUND_CONTEXT),
    ).rejects.toThrow(/defaultTrade|Unrecognized key/);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it("settles completed work automatically while offline browser work can yield to cloud work", async () => {
    const services = fromPartial<RunServices>({
      researchNext: vi.fn().mockResolvedValue({ state: "done" }),
      researchObserve: vi.fn().mockResolvedValue({ state: "paused_offline" }),
      researchResolve: vi.fn().mockResolvedValue({ state: "done" }),
    });
    expect(
      (
        await named("work_next", services).execute(
          {},
          api(),
          BACKGROUND_CONTEXT,
        )
      ).control,
    ).toEqual({ terminate: true });
    expect(
      (
        await named("work_observe", services).execute(
          { workRef, action: { kind: "read" } },
          api(),
          BACKGROUND_CONTEXT,
        )
      ).control,
    ).toBeUndefined();
    expect(
      (
        await named("work_resolve", services).execute(
          {
            workRef,
            status: "no_source_found",
            identity: {
              evidenceIds: [],
              reasoning: "No matching source found.",
            },
            detail: "Searched available sources.",
          },
          api(),
          BACKGROUND_CONTEXT,
        )
      ).control,
    ).toEqual({ terminate: true });
  });
  it("retains host escalation before returning a work observation, including replay after eviction", async () => {
    const output = { state: "ready", reasoningMode: "unfamiliar_resolution" };
    const services = fromPartial<RunServices>({
      researchNext: vi.fn().mockResolvedValue(output),
    });
    const retain = vi
      .fn()
      .mockRejectedValueOnce(new Error("settings unavailable"))
      .mockResolvedValue(undefined);
    const tool = purchaseImportTools(() => services, retain).find(
      (candidate) => candidate.name === "work_next",
    );
    if (!tool) throw new Error("Missing work_next");
    const execution = api();
    await expect(
      tool.execute({}, execution, BACKGROUND_CONTEXT),
    ).rejects.toThrow("settings unavailable");
    await tool.execute({}, execution, BACKGROUND_CONTEXT);
    expect(retain).toHaveBeenNthCalledWith(1, output);
    expect(retain).toHaveBeenNthCalledWith(2, output);
    expect(services.researchNext).toHaveBeenCalledTimes(1);
  });
});
