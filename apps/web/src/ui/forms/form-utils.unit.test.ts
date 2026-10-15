import { describe, expect, it } from "vitest";

import { buildUpdateObject, getSubmitButtonText } from "./form-utils";

describe("form-utils", () => {
  describe("getSubmitButtonText", () => {
    const CASES: { mode: "create" | "edit"; expected: string }[] = [
      { mode: "create", expected: "Create" },
      { mode: "edit", expected: "Save" },
    ];

    it.each(CASES)("$mode → $expected", ({ mode, expected }) => {
      expect(getSubmitButtonText(mode)).toBe(expected);
    });
  });

  describe("buildUpdateObject", () => {
    // Only fields that differ (by JSON equality) land in the update object.
    type FormValue =
      | string
      | number
      | boolean
      | null
      | undefined
      | string[]
      | { theme: string; notifications: boolean }
      | { date: Date; count: number };
    type FormData = Record<string, FormValue>;
    interface Case {
      name: string;
      entity: FormData;
      formValues: FormData;
      fields: string[];
      expected: Partial<FormData>;
    }

    const CASES: Case[] = [
      {
        name: "changed string field",
        entity: { name: "Original Name", description: "Same" },
        formValues: { name: "Updated Name", description: "Same" },
        fields: ["name", "description"],
        expected: { name: "Updated Name" },
      },
      {
        name: "changed number field",
        entity: { price: 10.5, quantity: 1 },
        formValues: { price: 15.0, quantity: 1 },
        fields: ["price", "quantity"],
        expected: { price: 15.0 },
      },
      {
        name: "changed boolean field",
        entity: { active: true, featured: false },
        formValues: { active: false, featured: false },
        fields: ["active", "featured"],
        expected: { active: false },
      },
      {
        name: "null → value",
        entity: { description: null, name: "Same" },
        formValues: { description: "New description", name: "Same" },
        fields: ["description", "name"],
        expected: { description: "New description" },
      },
      {
        name: "value → null",
        entity: { description: "Old description", name: "Same" },
        formValues: { description: null, name: "Same" },
        fields: ["description", "name"],
        expected: { description: null },
      },
      {
        name: "changed array field",
        entity: { tags: ["tag1", "tag2"], name: "Same" },
        formValues: { tags: ["tag1", "tag3"], name: "Same" },
        fields: ["tags", "name"],
        expected: { tags: ["tag1", "tag3"] },
      },
      {
        name: "changed nested object field",
        entity: {
          settings: { theme: "dark", notifications: true },
          name: "Same",
        },
        formValues: {
          settings: { theme: "light", notifications: true },
          name: "Same",
        },
        fields: ["settings", "name"],
        expected: { settings: { theme: "light", notifications: true } },
      },
      {
        name: "no changes → empty object",
        entity: { name: "Same Name", description: "Same Description" },
        formValues: { name: "Same Name", description: "Same Description" },
        fields: ["name", "description"],
        expected: {},
      },
      {
        name: "multiple field changes",
        entity: {
          name: "Old Name",
          description: "Old Description",
          price: 10.0,
          active: true,
        },
        formValues: {
          name: "New Name",
          description: "Old Description",
          price: 15.0,
          active: true,
        },
        fields: ["name", "description", "price", "active"],
        expected: { name: "New Name", price: 15.0 },
      },
      {
        name: "undefined vs null counts as a change",
        entity: { description: undefined, name: "Same" },
        formValues: { description: null, name: "Same" },
        fields: ["description", "name"],
        expected: { description: null },
      },
      {
        name: "complex JSON serialization edge cases",
        entity: {
          data: { date: new Date("2023-01-01"), count: 1 },
          name: "Same",
        },
        formValues: {
          data: { date: new Date("2023-01-01"), count: 2 },
          name: "Same",
        },
        fields: ["data", "name"],
        expected: { data: { date: new Date("2023-01-01"), count: 2 } },
      },
    ];

    it.each(CASES)("$name", ({ entity, formValues, fields, expected }) => {
      expect(buildUpdateObject(entity, formValues, fields)).toEqual(expected);
    });
  });
});
