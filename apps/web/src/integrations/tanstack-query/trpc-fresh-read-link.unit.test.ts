import { observable } from "@trpc/server/observable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRESH_READ_COOKIE_NAME } from "~/lib/fresh-read-marker";
import { createMutationFreshReadLink } from "./trpc-fresh-read-link";

function stubDocument() {
  let cookie = "";
  const documentStub = {};
  Object.defineProperty(documentStub, "cookie", {
    configurable: true,
    get: () => cookie,
    set: (value: string) => {
      cookie = value;
    },
  });
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("location", { protocol: "https:" });
  return () => cookie;
}

function runLink({
  type,
  result,
  error,
}: {
  type: "mutation" | "query";
  result?: unknown;
  error?: Error;
}) {
  const source = observable((observer) => {
    if (error) {
      observer.error(error);
    } else {
      observer.next({ result } as never);
      observer.complete();
    }
  });
  const link = createMutationFreshReadLink()({} as never);
  const events: unknown[] = [];
  link({
    op: {
      id: 1,
      type,
      path: "product.create",
      input: {},
      context: {},
      signal: null,
    } as never,
    next: (() => source) as never,
  }).subscribe({
    next: (value) => events.push(value),
    error: (value) => events.push(value),
    complete: () => events.push("complete"),
  });
  return events;
}

describe("tRPC fresh-read link", () => {
  let getCookie: () => string;

  beforeEach(() => {
    getCookie = stubDocument();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("marks successful mutation results before forwarding them", () => {
    const events = runLink({ type: "mutation", result: { data: "ok" } });

    expect(getCookie()).toContain(`${FRESH_READ_COOKIE_NAME}=1`);
    expect(events).toHaveLength(2);
  });

  it("does not mark failed mutations", () => {
    const events = runLink({
      type: "mutation",
      error: new Error("nope"),
    });

    expect(getCookie()).toBe("");
    expect(events[0]).toBeInstanceOf(Error);
  });

  it("does not mark query results", () => {
    runLink({ type: "query", result: { data: "ok" } });

    expect(getCookie()).toBe("");
  });
});
