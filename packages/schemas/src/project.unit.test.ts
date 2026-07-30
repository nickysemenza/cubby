import { describe, expect, it } from "vitest";
import { projectCreateInput, projectOut, projectUpdateData } from "./project";

describe("project resource URLs", () => {
  it("accepts and preserves complete Google Drive folder URLs", () => {
    const standard =
      "https://drive.google.com/drive/folders/abc123?usp=sharing#details";
    const accountPrefixed =
      "https://drive.google.com/drive/u/2/folders/def456?resourcekey=key";

    expect(
      projectCreateInput.parse({
        name: "Drive links",
        googleDriveFolderUrl: standard,
      }).googleDriveFolderUrl,
    ).toBe(standard);
    expect(
      projectUpdateData.parse({
        googleDriveFolderUrl: accountPrefixed,
      }).googleDriveFolderUrl,
    ).toBe(accountPrefixed);
  });

  it("accepts and preserves supported Notion page URLs", () => {
    const urls = [
      "https://notion.so/Project-0123456789abcdef",
      "https://www.notion.so/workspace/Project-0123456789abcdef?pvs=4",
      "https://cubby.notion.site/Project-0123456789abcdef#section",
      "https://docs.team.notion.site/Project-0123456789abcdef",
      "https://app.notion.com/p/nickysemenza/d4ffaba2e4b240ebb4aa8b7d80a7aabb",
      "https://app.notion.com/p/nickysemenza/Backyard-Project-Main-Page-d4ffaba2e4b240ebb4aa8b7d80a7aabb?source=copy_link",
    ];

    for (const notionPageUrl of urls) {
      expect(projectUpdateData.parse({ notionPageUrl }).notionPageUrl).toBe(
        notionPageUrl,
      );
    }
  });

  it("rejects invalid, insecure, and mismatched-provider URLs", () => {
    const invalidDriveUrls = [
      "not a URL",
      "http://drive.google.com/drive/folders/abc123",
      "https://drive.google.com/drive/my-drive",
      "https://notion.so/Project-0123456789abcdef",
    ];
    const invalidNotionUrls = [
      "not a URL",
      "http://notion.so/Project-0123456789abcdef",
      "https://notion.so/",
      "https://notion.so.evil.example/Project-0123456789abcdef",
      "https://notion.com/Project-0123456789abcdef",
      "https://evil.notion.com/Project-0123456789abcdef",
      "https://drive.google.com/drive/folders/abc123",
    ];

    for (const googleDriveFolderUrl of invalidDriveUrls) {
      expect(
        projectUpdateData.safeParse({ googleDriveFolderUrl }).success,
      ).toBe(false);
    }
    for (const notionPageUrl of invalidNotionUrls) {
      expect(projectUpdateData.safeParse({ notionPageUrl }).success).toBe(
        false,
      );
    }
  });

  it("normalizes empty input to null and exposes both fields in ProjectOut", () => {
    expect(
      projectCreateInput.parse({
        name: "Clear links",
        googleDriveFolderUrl: "",
        notionPageUrl: "   ",
      }),
    ).toMatchObject({
      googleDriveFolderUrl: null,
      notionPageUrl: null,
    });
    expect(
      projectUpdateData.parse({
        googleDriveFolderUrl: " ",
        notionPageUrl: "",
      }),
    ).toEqual({
      googleDriveFolderUrl: null,
      notionPageUrl: null,
    });
    expect(projectOut.shape.googleDriveFolderUrl).toBeDefined();
    expect(projectOut.shape.notionPageUrl).toBeDefined();
  });
});
