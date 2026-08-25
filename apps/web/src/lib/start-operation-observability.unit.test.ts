import { describe, expect, it } from "vitest";
import {
  readStartOperationTraceContext,
  startOperationHeaders,
  startOperationTraceAttributes,
} from "./start-operation-observability";

describe("Start operation trace context", () => {
  it("round-trips only the approved operation, kind, and entity dimensions", () => {
    const headers = new Headers(
      startOperationHeaders({
        operation: "entity.detail",
        kind: "query",
        entity: "product",
      }),
    );

    const context = readStartOperationTraceContext(headers);
    expect(context).toEqual({
      operation: "entity.detail",
      kind: "query",
      entity: "product",
    });
    expect(startOperationTraceAttributes(context)).toEqual({
      "rpc.system": "start",
      "rpc.method": "entity.detail",
      "rpc.type": "query",
      "cubby.entity": "product",
    });
  });

  it("drops arbitrary, mismatched, and high-cardinality header values", () => {
    expect(
      startOperationHeaders({
        operation: "entity.detail.secret-shortcode",
        kind: "query",
        entity: "product",
      }),
    ).toEqual({});
    expect(
      readStartOperationTraceContext(
        new Headers({
          "x-cubby-operation": "entity.detail",
          "x-cubby-operation-kind": "mutation",
          "x-cubby-operation-entity": "PRD-SECRET",
        }),
      ),
    ).toBeUndefined();
  });
});
