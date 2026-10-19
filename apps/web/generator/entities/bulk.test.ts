import assert from "node:assert/strict";
import test from "node:test";
import { deriveBulkUpdateFields } from "./bulk.ts";

test("bulk derivation keeps ordinary updates and shared references but excludes identity and owned attachments", () => {
  assert.deepEqual(
    deriveBulkUpdateFields(
      {
        update: [
          "name",
          "state",
          "groupId",
          "ownerId",
          "serial",
          "photos",
          "tokens",
          "computed",
        ],
        fields: [
          { key: "name", display: { standard: "name" } },
          { key: "state" },
          { key: "groupId", reference: { entity: "group" } },
          { key: "ownerId", reference: { entity: "owner" } },
          { key: "serial", semanticRole: "externalIdentifier" },
          { key: "photos", reference: { entity: "image" } },
          { key: "tokens", collection: { key: "value" } },
          { key: "computed", semanticRole: "attachment" },
        ],
      },
      [{ on: [{ column: "ownerId" }], unique: true }],
    ),
    ["state", "groupId", "tokens"],
  );
});

test("a unique foreign key is a one-to-one link, while an ordinary foreign key remains shareable", () => {
  assert.deepEqual(
    deriveBulkUpdateFields(
      {
        update: ["exclusiveId", "sharedId"],
        fields: [
          { key: "exclusiveId", reference: { entity: "target" } },
          { key: "sharedId", reference: { entity: "target" } },
        ],
      },
      [{ on: [{ column: "exclusiveId" }], unique: true }],
    ),
    ["sharedId"],
  );
});
