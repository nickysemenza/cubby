import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import * as arrange from "~/features/location/arrange/arrange-types";

import * as board from "./board-types";

const locationId = testShortcode("location", "shelf");
const inventoryEntryId = testShortcode("inventory", "item");
const taskId = testShortcode("task", "dragged");
const projectId = testShortcode("project", "target");
const wrongEntity = testShortcode("product", "wrong-entity");

/**
 * dnd-kit hands drag/drop payloads back untyped; each surface parses them at
 * ingress so a shortcode of the wrong entity (or a malformed one) never
 * reaches a move mutation. The task-board keyboard drag E2E covers the
 * accepted path through the real UI; this pins the refusals it cannot reach.
 */
describe("drag-and-drop ingress parsing", () => {
  it.each([
    {
      surface: "arrange drag",
      parse: arrange.asDragData,
      accepted: {
        arrangeDrag: "item",
        inventoryEntryId,
        amount: { value: 2, unit: "each" },
        sourceLocationId: locationId,
      },
      refused: {
        arrangeDrag: "location",
        locationId: wrongEntity,
        parentId: null,
      },
    },
    {
      surface: "arrange drop",
      parse: arrange.asDropData,
      accepted: { arrangeTarget: true, locationId },
      refused: { arrangeTarget: true, locationId: "not-a-shortcode" },
    },
    {
      surface: "task board drag",
      parse: board.asDragData,
      accepted: {
        taskBoardDrag: true,
        taskId,
        status: "in_progress",
        projectId,
        trade: "building",
      },
      refused: {
        taskBoardDrag: true,
        taskId: wrongEntity,
        status: "in_progress",
        projectId: null,
        trade: "building",
      },
    },
    {
      surface: "task board column drop",
      parse: board.asDropData,
      accepted: {
        taskBoardTarget: true,
        column: { kind: "project", projectId, projectName: "Kitchen" },
        lane: null,
      },
      refused: {
        taskBoardTarget: true,
        column: { kind: "status", status: "unknown" },
        lane: null,
      },
    },
    {
      surface: "task board card drop",
      parse: board.asCardDropData,
      accepted: {
        taskBoardCardTarget: true,
        column: { kind: "status", status: "done" },
        lane: { kind: "trade", trade: "building" },
        targetTaskId: taskId,
      },
      refused: {
        taskBoardCardTarget: true,
        column: { kind: "status", status: "done" },
        lane: null,
        targetTaskId: wrongEntity,
      },
    },
  ])(
    "$surface keeps branded ids and refuses cross-entity ones",
    ({ parse, accepted, refused }) => {
      expect(parse(accepted)).toEqual(accepted);
      expect(parse(refused)).toBeNull();
    },
  );
});
