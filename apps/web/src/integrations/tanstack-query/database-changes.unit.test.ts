import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { subscribeDatabaseChanges } from "./database-changes";
import { matchesDatabaseChanges } from "./operation-cache";
import type { OperationCacheTag } from "./operation-meta";

function cached(
  client: QueryClient,
  operation: string,
  input: unknown,
  tags: OperationCacheTag[],
) {
  const queryKey = ["operation", operation, { input }];
  client.setQueryDefaults(queryKey, { meta: { operation, cacheTags: tags } });
  client.setQueryData(queryKey, { retained: true });
  const query = client.getQueryCache().find({ queryKey });
  if (!query) throw new Error("Missing synthetic query");
  return query;
}

class Socket extends EventTarget {
  static OPEN = 1;
  static current: Socket;
  readyState = Socket.OPEN;
  constructor() {
    super();
    Socket.current = this;
  }
  close() {}
  ring(changes: Record<string, string[] | null>) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "ring",
          topic: "household.changed",
          changes,
        }),
      }),
    );
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("household change invalidation", () => {
  it("narrows detail, report and connection reads while retaining lists, counts and null ripples", () => {
    const client = new QueryClient();
    const detailA = cached(
      client,
      "entity.detail",
      { entity: "imageJob", shortcode: "IPR-A3F2" },
      [["imageJob"]],
    );
    const detailB = cached(
      client,
      "entity.detail",
      { entity: "imageJob", shortcode: "IPR-B4G3" },
      [["imageJob"]],
    );
    const reportB = cached(
      client,
      "entityReport.get",
      { slot: "imageJob.attempts", scope: { kind: "record", id: "IPR-B4G3" } },
      [["image"]],
    );
    const reportsB = cached(
      client,
      "entityReport.getMany",
      { slots: ["imageJob.attempts"], id: "IPR-B4G3" },
      [["image"]],
    );
    const connectedB = cached(
      client,
      "entityGraph.connectedRecords",
      {
        source: { entityKind: "imageJob", entityId: "IPR-B4G3" },
        viewKey: "relation:images",
      },
      [["relatedData"]],
    );
    const reportA = cached(
      client,
      "entityReport.get",
      { slot: "imageJob.attempts", scope: { kind: "record", id: "IPR-A3F2" } },
      [["image"]],
    );
    expect(matchesDatabaseChanges({ imageJob: ["IPR-A3F2"] })(reportA)).toBe(
      true,
    );
    expect(matchesDatabaseChanges({ imageJob: ["IPR-A3F2"] })(reportB)).toBe(
      false,
    );
    const list = cached(client, "entity.list", {}, [["imageJob"]]);
    const counts = cached(client, "dashboard.counts", {}, [["dashboard"]]);
    const narrowed = matchesDatabaseChanges({
      imageJob: ["IPR-A3F2"],
      image: ["IMG-A3F2"],
      relatedData: null,
    });
    expect(
      [detailA, detailB, reportB, reportsB, connectedB, list, counts].map(
        narrowed,
      ),
    ).toEqual([true, false, false, false, true, true, true]);
    // A whole-category change coalesced into the same ring still reaches B;
    // an id-scoped one does not.
    expect(
      matchesDatabaseChanges({ imageJob: ["IPR-A3F2"], image: null })(reportB),
    ).toBe(true);
    expect(
      matchesDatabaseChanges({ imageJob: ["IPR-A3F2"], image: ["IMG-A3F2"] })(
        reportB,
      ),
    ).toBe(false);
    expect(
      [detailA, detailB].map(matchesDatabaseChanges({ imageJob: null })),
    ).toEqual([true, true]);
    const full = matchesDatabaseChanges({
      imageJob: null,
      image: null,
      relatedData: null,
    });
    expect(
      [detailA, detailB, reportB, reportsB, connectedB, list, counts].map(full),
    ).toEqual([true, true, true, true, true, true, true]);
    client.clear();
  });

  it("refreshes at the leading edge, at most every five seconds, and once after the final ring", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("window", new EventTarget());
    Object.defineProperty(window, "location", {
      value: { origin: "https://example.test" },
    });
    vi.stubGlobal(
      "document",
      Object.assign(new EventTarget(), { visibilityState: "visible" }),
    );
    vi.stubGlobal("navigator", { onLine: true });
    const client = new QueryClient();
    const queryA = cached(
      client,
      "entity.detail",
      { entity: "imageJob", shortcode: "IPR-A3F2" },
      [["imageJob"]],
    );
    const queryB = cached(
      client,
      "entity.detail",
      { entity: "imageJob", shortcode: "IPR-B4G3" },
      [["imageJob"]],
    );
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const stop = subscribeDatabaseChanges(client);
    Socket.current.dispatchEvent(new Event("open"));
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidate).toHaveBeenCalledTimes(1);
    Socket.current.ring({ imageJob: ["IPR-A3F2"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    Socket.current.ring({ imageJob: ["IPR-B4G3"] });
    await vi.advanceTimersByTimeAsync(1000);
    Socket.current.ring({ imageJob: ["IPR-A3F2"] });
    await vi.advanceTimersByTimeAsync(2999);
    expect(invalidate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(invalidate).toHaveBeenCalledTimes(3);
    const trailing = invalidate.mock.calls[2]?.[0]?.predicate;
    expect(trailing?.(queryA)).toBe(true);
    expect(trailing?.(queryB)).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    Socket.current.ring({ imageJob: ["IPR-B4G3"] });
    await vi.advanceTimersByTimeAsync(4000);
    expect(invalidate).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(5000);
    expect(invalidate).toHaveBeenCalledTimes(4);
    Socket.current.ring({ imageJob: ["IPR-A3F2"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(invalidate).toHaveBeenCalledTimes(5);
    Socket.current.ring({ imageJob: ["IPR-B4G3"] });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(invalidate).toHaveBeenCalledTimes(5);
    client.clear();
  });
});
