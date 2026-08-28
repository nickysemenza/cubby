import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { imageWithEntitySchema } from "@cubby/schemas/image";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import { mock } from "~/lib/test/mock-schema";

import {
  projectImageSummaries,
  updateImageThenReload,
} from "./image-browser.server";

const refreshedImage = mock(imageWithEntitySchema, {
  seed: 8,
  overrides: {
    id: "IMG-4K7M",
    filename: "renamed.jpg",
    entityType: "PRODUCT",
    entityId: "PRD-4K7M",
  },
});

describe("Image browser operations", () => {
  it("reloads the enriched projection after updating the row", async () => {
    const commands: string[] = [];
    const ports = {
      async update(_context: { source: string }) {
        commands.push("update");
      },
      async get(_context: { source: string }) {
        commands.push("get");
        return refreshedImage;
      },
    };

    await expect(
      updateImageThenReload(
        ports,
        { source: "test" },
        {
          id: parseShortcodeFor("image", "IMG-4K7M"),
          data: { filename: "renamed.jpg" },
        },
      ),
    ).resolves.toMatchObject({
      id: "IMG-4K7M",
      entityType: "PRODUCT",
    });

    expect(commands).toEqual(["update", "get"]);
  });

  it("rejects a project summary zip when resolution drops a project", () => {
    expect(() =>
      projectImageSummaries(
        [
          testShortcode("project", "PRJ-4K7M"),
          testShortcode("project", "PRJ-7M2P"),
        ],
        ["project-uuid"],
        {},
      ),
    ).toThrow("Project resolution changed result cardinality");
  });
});
