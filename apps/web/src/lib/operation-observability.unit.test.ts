import { describe, expect, it } from "vitest";

import { OPERATIONS } from "./generated/operation-registry.gen";
import {
  readOperationTraceContext,
  operationDefinitionFor,
  operationTraceHeaders,
  operationTraceAttributes,
  type OperationTraceContext,
} from "./operation-observability";

describe("operation trace context", () => {
  it("round-trips every generated operation definition", () => {
    for (const operation of Object.keys(OPERATIONS)) {
      const registered = operationDefinitionFor(operation);
      if (!registered) throw new Error(`Missing operation ${operation}`);
      const entity = registered.entities[0];
      const headerInput = {
        operation: registered.id,
        kind: registered.kind,
      };
      const expected: OperationTraceContext = { ...headerInput };
      if (entity) expected.entity = entity;
      const headers = operationTraceHeaders(
        entity ? { ...headerInput, entity } : headerInput,
      );
      expect(readOperationTraceContext(new Headers(headers))).toEqual(expected);
    }
  });

  it("round-trips only the approved operation, kind, and entity dimensions", () => {
    const headers = new Headers(
      operationTraceHeaders({
        operation: "entity.detail",
        kind: "query",
        entity: "product",
      }),
    );

    const context = readOperationTraceContext(headers);
    expect(context).toEqual({
      operation: "entity.detail",
      kind: "query",
      entity: "product",
    });
    expect(operationTraceAttributes(context)).toEqual({
      "rpc.system": "start",
      "rpc.method": "entity.detail",
      "rpc.type": "query",
      "cubby.entity": "product",
    });
  });

  it("drops arbitrary, mismatched, and high-cardinality header values", () => {
    expect(
      readOperationTraceContext(
        new Headers({
          "x-cubby-operation": "entity.detail.secret-shortcode",
          "x-cubby-operation-kind": "query",
          "x-cubby-operation-entity": "product",
        }),
      ),
    ).toBeUndefined();
    expect(
      readOperationTraceContext(
        new Headers({
          "x-cubby-operation": "entity.detail",
          "x-cubby-operation-kind": "query",
          "x-cubby-operation-entity": "usda-food",
        }),
      ),
    ).toEqual({ operation: "entity.detail", kind: "query" });
    expect(
      readOperationTraceContext(
        new Headers({
          "x-cubby-operation": "entity.detail",
          "x-cubby-operation-kind": "mutation",
          "x-cubby-operation-entity": "PRD-SECRET",
        }),
      ),
    ).toBeUndefined();
    expect(
      readOperationTraceContext(
        new Headers({
          "x-cubby-operation": "cookbook.list",
          "x-cubby-operation-kind": "query",
          "x-cubby-operation-entity": "product",
        }),
      ),
    ).toEqual({ operation: "cookbook.list", kind: "query" });
  });
});
