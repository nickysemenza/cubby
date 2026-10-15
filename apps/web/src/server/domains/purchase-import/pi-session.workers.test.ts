import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  ProviderDoc,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { fromPartial } from "@total-typescript/shoehorn";
import { PiHarness } from "agents/harness/pi";
import type { LifecycleServices } from "agents/lifecycle";
import { afterEach, describe, expect, it, vi } from "vitest";

class DurableMemoryStorage extends MemoryStorage {
  failReads = false;
  closeGate = Promise.resolve();

  override async conversation(
    ...args: Parameters<MemoryStorage["conversation"]>
  ) {
    if (this.failReads) throw new Error("Synthetic storage read failure");
    return super.conversation(...args);
  }

  // Like the Durable Object adapter, closing a handle leaves the database intact.
  override async close() {
    await this.closeGate;
  }
}

const context = BACKGROUND_CONTEXT;

class TestPiHarness extends PiHarness {
  // Exercise the real cache while isolating its Cloudflare lifecycle seam.
  override get lifecycle(): LifecycleServices {
    return fromPartial({ ready: async () => {}, storage: {} });
  }
}

function host(storage: DurableMemoryStorage, opened = (_pi: Harness) => {}) {
  const harness = new TestPiHarness({
    harness: async ({ context }) => {
      const pi = await Harness.open(
        storage,
        { models: createModels(), registry: createRegistry() },
        context,
      );
      opened(pi);
      return pi;
    },
  });
  vi.spyOn(SqliteStorage, "open").mockResolvedValue(fromPartial(storage));
  return harness;
}

afterEach(() => vi.restoreAllMocks());

describe("pi session recovery", () => {
  it("reopens a failed cached session and retains its persisted provider identity", async () => {
    const storage = new DurableMemoryStorage();
    const harness = host(storage);
    const first = await harness.pi();
    const root = await first.root(context);
    const provider = await first.snapshot(ProviderDoc, root.id, context);
    expect(provider?.sessionId).toBeTruthy();
    storage.failReads = true;
    await expect(first.conversation(root.id, context)).rejects.toThrow(
      "Synthetic storage read failure",
    );
    await first.closed;
    storage.failReads = false;
    const second = await harness.pi();
    expect(second === first).toBe(false);
    expect(await second.snapshot(ProviderDoc, root.id, context)).toEqual(
      provider,
    );
    await harness.dispose();
  });

  it("retains a replacement paused in storage initialization when failed root startup finishes closing", async () => {
    const storage = new DurableMemoryStorage();
    const close = Promise.withResolvers<void>();
    storage.closeGate = close.promise;
    let first: Harness | undefined;
    const harness = host(storage, (pi) => {
      first ??= pi;
      if (pi === first) storage.failReads = true;
    });
    await expect(harness.pi()).rejects.toThrow(
      "Synthetic storage read failure",
    );
    storage.failReads = false;
    const entered = Promise.withResolvers<void>();
    const initialize = Promise.withResolvers<void>();
    vi.mocked(SqliteStorage.open).mockImplementationOnce(async () => {
      entered.resolve();
      await initialize.promise;
      return fromPartial(storage);
    });
    const replacement = harness.pi();
    await entered.promise;
    close.resolve();
    await first?.closed;
    initialize.resolve();
    const second = await replacement;
    expect((await harness.pi()) === second).toBe(true);
    expect(await second.root(context)).toBeDefined();
    await harness.dispose();
  });

  it("retains a replacement when a previously opened failed session finishes closing", async () => {
    const storage = new DurableMemoryStorage();
    const harness = host(storage);
    const first = await harness.pi();
    const root = await first.root(context);
    const close = Promise.withResolvers<void>();
    storage.closeGate = close.promise;
    storage.failReads = true;
    await expect(first.conversation(root.id, context)).rejects.toThrow(
      "Synthetic storage read failure",
    );
    storage.failReads = false;
    const disposing = harness.dispose();
    const second = await harness.pi();
    close.resolve();
    await disposing;
    await first.closed;
    expect((await harness.pi()) === second).toBe(true);
    expect(await second.root(context)).toBeDefined();
    await harness.dispose();
  });
});
