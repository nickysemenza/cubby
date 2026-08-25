import {
  dehydrate,
  hydrate,
  QueryClient,
  QueryObserver,
} from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reset, snapshot } from "~/lib/perf/perf-store";
import {
  beginObservedOperation,
  finishObservedOperation,
  installOperationRecorder,
  operationHeaders,
} from "./operation-recorder";

const createClient = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("operation recorder", () => {
  afterEach(() => {
    reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("records tRPC fetches and successful cache reuse", async () => {
    const client = createClient();
    const uninstall = installOperationRecorder(client);
    const options = {
      queryKey: [["project", "list"], { input: {}, type: "query" }] as const,
      queryFn: async () => ({ items: [] }),
      staleTime: Number.POSITIVE_INFINITY,
    };
    await client.fetchQuery(options);
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => undefined);

    expect(snapshot().queries["trpc:project.list"]).toMatchObject({
      fetches: 1,
      reuses: 1,
      errors: 0,
    });
    unsubscribe();
    uninstall();
  });

  it("records a hydrated baseline before an observer mounts", async () => {
    const source = createClient();
    await source.fetchQuery({
      queryKey: [["product", "detail"], { shortcode: "PRD-4K7M" }],
      queryFn: async () => ({ id: "PRD-4K7M" }),
    });
    const client = createClient();
    const uninstall = installOperationRecorder(client);
    hydrate(client, dehydrate(source));

    expect(snapshot().queries["client:product.detail"]).toMatchObject({
      hydrated: 1,
      fetches: 0,
    });
    uninstall();
  });

  it("shares a Start operation id with headers and mutation history", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const operation = beginObservedOperation({
      kind: "mutation",
      transport: "start",
      operation: "entity.mutate",
      entity: "product",
      input: { action: "update" },
    });
    expect(
      new Headers(operationHeaders(operation)).get("x-cubby-operation-id"),
    ).toBe(operation.id);
    finishObservedOperation(operation, { result: { ok: true } });

    expect(snapshot().mutations[0]).toMatchObject({
      id: operation.id,
      operation: "entity.mutate",
      transport: "start",
      entity: "product",
      outcome: "success",
    });
  });

  it("always logs Start failures and exposes their shared operation id", () => {
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      localStorage: { getItem: () => "false" },
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const operation = beginObservedOperation({
      kind: "query",
      transport: "start",
      operation: "entity.list",
      entity: "product",
      input: {},
    });

    finishObservedOperation(operation, { error: new Error("failed") });

    expect(errorLog).toHaveBeenCalledOnce();
    expect(snapshot().queries["start:entity.list"]?.lastOperationId).toBe(
      operation.id,
    );
  });
});
