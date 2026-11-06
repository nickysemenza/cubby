import { actionAvailabilityRules } from "@cubby/schemas/action-availability";
import { describe, expect, it } from "vitest";

import { listEntities } from "~/entity/model/list-contracts";
import { listReadSchema } from "~/server/generic/list/repo/list-read-schema";

import {
  entityActionReadFields,
  entityActionStates,
} from "./entity-action-states";

const stateOf = (entity: "vendor" | "task", record: unknown, id: string) =>
  entityActionStates(entity, record).find((action) => action.id === id);

describe("entityActionStates", () => {
  it("covers declared and kernel verbs, refusing an unmet requirement with its reason", () => {
    const ids = entityActionStates("vendor", {}).map((action) => action.id);
    expect(ids).toEqual(expect.arrayContaining(["edit", "fetchLogo", "merge"]));
    expect(stateOf("vendor", { website: null }, "fetchLogo")).toEqual({
      id: "fetchLogo",
      enabled: false,
      reason: actionAvailabilityRules.fetchLogo.requires.reason,
    });
    expect(
      stateOf("vendor", { website: "https://shop.example" }, "fetchLogo"),
    ).toEqual({ id: "fetchLogo", enabled: true, reason: null });
    expect(stateOf("vendor", { website: null }, "edit")?.enabled).toBe(true);
  });

  it("refuses a preset write the record already carries", () => {
    expect(stateOf("task", { status: "done" }, "complete")).toEqual({
      id: "complete",
      enabled: false,
      reason: "Already done.",
    });
    expect(stateOf("task", { status: "todo" }, "complete")?.enabled).toBe(true);
  });

  it("reads each rule's field on every list that offers the verb", () => {
    for (const entity of listEntities) {
      const fields = entityActionReadFields(entity);
      const readable = listReadSchema(entity).shape;
      for (const field of fields)
        expect(readable, `${entity}.${field}`).toHaveProperty(field);
    }
  });
});
