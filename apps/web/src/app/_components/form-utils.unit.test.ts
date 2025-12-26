import { describe, expect, test } from "vitest";
import {
  getSubmitButtonText,
  buildUpdateObject,
  detectComboboxIdChange,
} from "./form-utils";
import type { ComboboxItem } from "./combobox/combobox-types";

describe("form-utils", () => {
  describe("getSubmitButtonText", () => {
    test("returns 'Create' for create mode when not pending", () => {
      const result = getSubmitButtonText("create", false);
      expect(result).toBe("Create");
    });

    test("returns 'Creating...' for create mode when pending", () => {
      const result = getSubmitButtonText("create", true);
      expect(result).toBe("Creating...");
    });

    test("returns 'Save' for edit mode when not pending", () => {
      const result = getSubmitButtonText("edit", false);
      expect(result).toBe("Save");
    });

    test("returns 'Saving...' for edit mode when pending", () => {
      const result = getSubmitButtonText("edit", true);
      expect(result).toBe("Saving...");
    });
  });

  describe("buildUpdateObject", () => {
    test("detects changed string field", () => {
      const entity = { name: "Original Name", description: "Same" };
      const formValues = { name: "Updated Name", description: "Same" };

      const result = buildUpdateObject(entity, formValues, [
        "name",
        "description",
      ]);

      expect(result).toEqual({ name: "Updated Name" });
    });

    test("detects changed number field", () => {
      const entity = { price: 10.5, quantity: 1 };
      const formValues = { price: 15.0, quantity: 1 };

      const result = buildUpdateObject(entity, formValues, [
        "price",
        "quantity",
      ]);

      expect(result).toEqual({ price: 15.0 });
    });

    test("detects changed boolean field", () => {
      const entity = { active: true, featured: false };
      const formValues = { active: false, featured: false };

      const result = buildUpdateObject(entity, formValues, [
        "active",
        "featured",
      ]);

      expect(result).toEqual({ active: false });
    });

    test("detects changed null to value", () => {
      const entity = { description: null, name: "Same" };
      const formValues = { description: "New description", name: "Same" };

      const result = buildUpdateObject(entity, formValues, [
        "description",
        "name",
      ]);

      expect(result).toEqual({ description: "New description" });
    });

    test("detects changed value to null", () => {
      const entity = { description: "Old description", name: "Same" };
      const formValues = { description: null, name: "Same" };

      const result = buildUpdateObject(entity, formValues, [
        "description",
        "name",
      ]);

      expect(result).toEqual({ description: null });
    });

    test("detects changed array field", () => {
      const entity = { tags: ["tag1", "tag2"], name: "Same" };
      const formValues = { tags: ["tag1", "tag3"], name: "Same" };

      const result = buildUpdateObject(entity, formValues, ["tags", "name"]);

      expect(result).toEqual({ tags: ["tag1", "tag3"] });
    });

    test("detects changed nested object field", () => {
      const entity = {
        settings: { theme: "dark", notifications: true },
        name: "Same",
      };
      const formValues = {
        settings: { theme: "light", notifications: true },
        name: "Same",
      };

      const result = buildUpdateObject(entity, formValues, [
        "settings",
        "name",
      ]);

      expect(result).toEqual({
        settings: { theme: "light", notifications: true },
      });
    });

    test("returns empty object when no changes detected", () => {
      const entity = { name: "Same Name", description: "Same Description" };
      const formValues = { name: "Same Name", description: "Same Description" };

      const result = buildUpdateObject(entity, formValues, [
        "name",
        "description",
      ]);

      expect(result).toEqual({});
    });

    test("handles multiple field changes", () => {
      const entity = {
        name: "Old Name",
        description: "Old Description",
        price: 10.0,
        active: true,
      };
      const formValues = {
        name: "New Name",
        description: "Old Description",
        price: 15.0,
        active: true,
      };

      const result = buildUpdateObject(entity, formValues, [
        "name",
        "description",
        "price",
        "active",
      ]);

      expect(result).toEqual({
        name: "New Name",
        price: 15.0,
      });
    });

    test("handles undefined vs null correctly", () => {
      const entity = { description: undefined, name: "Same" };
      const formValues = { description: null, name: "Same" };

      const result = buildUpdateObject(entity, formValues, [
        "description",
        "name",
      ]);

      expect(result).toEqual({ description: null });
    });

    test("handles complex JSON serialization edge cases", () => {
      const entity = {
        data: { date: new Date("2023-01-01"), count: 1 },
        name: "Same",
      };
      const formValues = {
        data: { date: new Date("2023-01-01"), count: 2 },
        name: "Same",
      };

      const result = buildUpdateObject(entity, formValues, ["data", "name"]);

      expect(result).toEqual({
        data: { date: new Date("2023-01-01"), count: 2 },
      });
    });
  });

  describe("detectComboboxIdChange", () => {
    test("returns undefined when entity is null and combobox is null/undefined", () => {
      expect(detectComboboxIdChange(null, null)).toBeUndefined();
      expect(detectComboboxIdChange(null, undefined)).toBeUndefined();
    });

    test("handles undefined entity ID with null combobox", () => {
      // When entityId is undefined and combobox is null, it should return null (removing association)
      const result = detectComboboxIdChange(undefined, null);
      expect(result).toBe(null);
    });

    test("returns combobox ID when entity is null and combobox has value", () => {
      const comboboxItem: ComboboxItem = { id: "new-id", name: "New Item" };
      const result = detectComboboxIdChange(null, comboboxItem);
      expect(result).toBe("new-id");
    });

    test("returns null when entity has value and combobox is empty", () => {
      const result = detectComboboxIdChange("existing-id", null);
      expect(result).toBe(null);
    });

    test("returns new ID when combobox ID differs from entity ID", () => {
      const comboboxItem: ComboboxItem = { id: "new-id", name: "New Item" };
      const result = detectComboboxIdChange("old-id", comboboxItem);
      expect(result).toBe("new-id");
    });

    test("returns undefined when combobox ID matches entity ID", () => {
      const comboboxItem: ComboboxItem = { id: "same-id", name: "Same Item" };
      const result = detectComboboxIdChange("same-id", comboboxItem);
      expect(result).toBeUndefined();
    });

    test("handles undefined entity ID with combobox value", () => {
      const comboboxItem: ComboboxItem = { id: "new-id", name: "New Item" };
      const result = detectComboboxIdChange(undefined, comboboxItem);
      expect(result).toBe("new-id");
    });

    test("handles undefined entity ID with undefined combobox", () => {
      // When both are undefined, the function falls through to checking entityId !== null (true for undefined)
      // and !comboboxItem (true for undefined), so it returns null
      const result = detectComboboxIdChange(undefined, undefined);
      expect(result).toBe(null);
    });

    test("handles string entity ID with empty combobox", () => {
      const result = detectComboboxIdChange("entity-id", undefined);
      expect(result).toBe(null);
    });

    test("correctly identifies no change scenario", () => {
      const comboboxItem: ComboboxItem = {
        id: "same-id",
        name: "Item Label",
      };
      const result = detectComboboxIdChange("same-id", comboboxItem);
      expect(result).toBeUndefined();
    });

    test("handles empty string entity ID", () => {
      const comboboxItem: ComboboxItem = { id: "new-id", name: "New Item" };
      const result = detectComboboxIdChange("", comboboxItem);
      expect(result).toBe("new-id");
    });

    test("handles empty string combobox ID", () => {
      const comboboxItem: ComboboxItem = { id: "", name: "Empty ID Item" };
      const result = detectComboboxIdChange("entity-id", comboboxItem);
      expect(result).toBe("");
    });
  });
});
