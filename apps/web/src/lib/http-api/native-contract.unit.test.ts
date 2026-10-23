import { describe, expect, it } from "vitest";

import { httpContract } from "~/lib/generated/http-contract.gen";

import { collectNativeContract } from "../../../generator/http-api/native-contract";
import { httpMetadataSchema } from "./router";
import { httpRoutes } from "./routes";

const native = collectNativeContract(httpContract);
const operation = (id: string) => {
  const route = native.operations.find((entry) => entry.id === id);
  if (!route) throw new Error(`Missing native operation ${id}`);
  return route;
};

describe("declared native interface", () => {
  it("exposes precisely the HTTP declarations and their actual routes", () => {
    const declared = httpRoutes(httpContract)
      .map((route) => ({
        id: httpMetadataSchema.parse(route.metadata).operation,
        method: route.method,
        path: route.path,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(
      native.operations.map(({ id, method, path }) => ({ id, method, path })),
    ).toEqual(declared);
  });

  it("keeps native calendar input scoped to its date window", () => {
    const body = operation("calendar.range").body;
    if (!body) throw new Error("Calendar range requires a body");
    const schema = native.models[body];
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      "endDateExclusive",
      "kinds",
      "startDate",
    ]);
    expect(schema?.required).toEqual(
      expect.arrayContaining(["startDate", "endDateExclusive"]),
    );
  });

  it("uses direct JSON for manifest lists and shared presentation consumers", () => {
    for (const id of [
      "entity.listBase",
      "entity.listEnrichment",
      "entity.listSummary",
    ]) {
      expect(operation(id).body).toBe("input/NativeJSON");
      expect(operation(id).output).toBe("output/NativeJSON");
    }
    for (const id of [
      "project.dashboardSummary",
      "run.workSnapshot",
      "run.work",
      "run.control",
    ]) {
      expect(operation(id).output).toBe("output/NativeJSON");
    }
    expect(operation("run.control").body).toBe("input/NativeJSON");
  });
});
