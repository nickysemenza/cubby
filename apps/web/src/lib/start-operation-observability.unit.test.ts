import { describe, expect, it } from "vitest";
import { START_OPERATIONS } from "./generated/start-operation-registry.gen";
import {
  readStartOperationTraceContext,
  startOperationHeaders,
  startOperationTraceAttributes,
} from "./start-operation-observability";

describe("Start operation trace context", () => {
  it("round-trips every generated operation definition", () => {
    for (const [operation, definition] of Object.entries(START_OPERATIONS)) {
      const entity = definition.entities[0];
      const headers = startOperationHeaders({
        operation: operation as keyof typeof START_OPERATIONS,
        kind: definition.kind,
        ...(entity ? { entity } : {}),
      });
      expect(readStartOperationTraceContext(new Headers(headers))).toEqual({
        operation,
        kind: definition.kind,
        ...(entity ? { entity } : {}),
      });
    }
  });

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
      readStartOperationTraceContext(
        new Headers({
          "x-cubby-operation": "entity.detail.secret-shortcode",
          "x-cubby-operation-kind": "query",
          "x-cubby-operation-entity": "product",
        }),
      ),
    ).toBeUndefined();
    expect(
      readStartOperationTraceContext(
        new Headers({
          "x-cubby-operation": "entity.detail",
          "x-cubby-operation-kind": "mutation",
          "x-cubby-operation-entity": "PRD-SECRET",
        }),
      ),
    ).toBeUndefined();
    expect(
      readStartOperationTraceContext(
        new Headers({
          "x-cubby-operation": "cookbook.list",
          "x-cubby-operation-kind": "query",
          "x-cubby-operation-entity": "product",
        }),
      ),
    ).toEqual({ operation: "cookbook.list", kind: "query" });
  });
});
