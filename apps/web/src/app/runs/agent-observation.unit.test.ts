import type {
  AgentConversationObservation,
  AgentConversationObservationSnapshot,
} from "@flue/sdk";
import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createObservationRegistry,
  photoReviewPollInterval,
  watchAgentChanges,
} from "./agent-observation";

const created: Array<ReturnType<typeof fakeObservation>> = [];

const registry = createObservationRegistry(() => {
  const fake = fakeObservation();
  created.push(fake);
  return fake.observation;
});
const retainAgentObservation = registry.retain;

function fakeObservation() {
  let snapshot: AgentConversationObservationSnapshot = {
    conversation: undefined,
    offset: undefined,
    phase: "loading",
    error: undefined,
  };
  const listeners = new Set<() => void>();
  const close = vi.fn();
  const observation: AgentConversationObservation = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(),
    close,
  };
  return {
    observation,
    close,
    listenerCount: () => listeners.size,
    publish(next: Partial<AgentConversationObservationSnapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) listener();
    },
  };
}

const conversation = (messageCount: number, partsPerMessage = 1) =>
  fromPartial<AgentConversationObservationSnapshot["conversation"]>({
    messages: Array.from({ length: messageCount }, () => ({
      parts: Array.from({ length: partsPerMessage }),
    })),
    settlements: [],
  });

beforeEach(() => {
  created.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watchAgentChanges", () => {
  it("fires on a phase change and on new messages or parts, not on identical snapshots", () => {
    const fake = fakeObservation();
    const onChange = vi.fn();
    watchAgentChanges(fake.observation, onChange, 1_000);

    fake.publish({ phase: "live" });
    expect(onChange).toHaveBeenCalledTimes(1);

    // Same phase and same content: a token delta inside one part.
    vi.advanceTimersByTime(1_000);
    fake.publish({ conversation: conversation(1) });
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    fake.publish({ conversation: conversation(1) });
    expect(onChange).toHaveBeenCalledTimes(2);

    // A tool call adds a part to the same message.
    fake.publish({ conversation: conversation(1, 2) });
    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("collapses a burst into a leading and one trailing call", () => {
    const fake = fakeObservation();
    const onChange = vi.fn();
    watchAgentChanges(fake.observation, onChange, 1_000);

    fake.publish({ phase: "connecting" });
    fake.publish({ phase: "live" });
    fake.publish({ conversation: conversation(1) });
    fake.publish({ conversation: conversation(2) });
    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(onChange).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(5_000);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("stops listening and drops a pending trailing call", () => {
    const fake = fakeObservation();
    const onChange = vi.fn();
    const stop = watchAgentChanges(fake.observation, onChange, 1_000);

    fake.publish({ phase: "live" });
    fake.publish({ conversation: conversation(1) });
    stop();
    vi.advanceTimersByTime(5_000);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(fake.listenerCount()).toBe(0);
  });
});

describe("retainAgentObservation", () => {
  it("shares one stream between retainers and closes it after the last release", async () => {
    const releaseSurface = retainAgentObservation("RUN-SHARE");
    const releaseReview = retainAgentObservation("RUN-SHARE");
    expect(created).toHaveLength(1);

    releaseSurface();
    await Promise.resolve();
    expect(created[0]?.close).not.toHaveBeenCalled();

    releaseReview();
    await Promise.resolve();
    expect(created[0]?.close).toHaveBeenCalledTimes(1);

    // A later mount opens a fresh stream instead of reusing the closed one.
    const releaseAgain = retainAgentObservation("RUN-SHARE");
    expect(created).toHaveLength(2);
    releaseAgain();
  });

  it("keeps the stream through a synchronous release and re-retain", async () => {
    const release = retainAgentObservation("RUN-REMOUNT");
    release();
    const releaseRemount = retainAgentObservation("RUN-REMOUNT");
    await Promise.resolve();

    expect(created).toHaveLength(1);
    expect(created[0]?.close).not.toHaveBeenCalled();
    releaseRemount();
  });
});

describe("photoReviewPollInterval", () => {
  const idle = { images: [{ cutout: "done", describe: "done" }] };
  const busy = { images: [{ cutout: "leased", describe: "done" }] };

  it("polls every 3s while a live run has no agent stream to tell it what changed", () => {
    expect(
      photoReviewPollInterval({
        runStatus: "running",
        agentLive: false,
        data: idle,
      }),
    ).toBe(3_000);
  });

  it("relaxes to a 30s safety poll while the agent stream is live", () => {
    expect(
      photoReviewPollInterval({
        runStatus: "running",
        agentLive: true,
        data: idle,
      }),
    ).toBe(30_000);
  });

  it("keeps the 15s worker poll, which the agent stream does not signal", () => {
    expect(
      photoReviewPollInterval({
        runStatus: "running",
        agentLive: true,
        data: busy,
      }),
    ).toBe(15_000);
    expect(
      photoReviewPollInterval({
        runStatus: "completed",
        agentLive: false,
        data: busy,
      }),
    ).toBe(15_000);
  });

  it("stops once the run is over and no worker is pending", () => {
    expect(
      photoReviewPollInterval({
        runStatus: "completed",
        agentLive: false,
        data: idle,
      }),
    ).toBe(false);
  });
});
