import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EntityFormProps } from "~/app/_components/form-utils";

import { useEntityFormController } from "./use-entity-form-controller";

interface IngredientFormValues {
  name: string;
}

interface IngredientRecord {
  id: string;
  name: string;
}

type IngredientUpdatePayload = Partial<IngredientRecord>;

interface LocationFormValues {
  name: string;
  product: { id: string; name: string } | null;
  parent: { id: string; name: string } | null;
}

interface LocationRecord {
  id: string;
  name: string;
  product: { id: string; name: string } | null;
  parent: { id: string; name: string } | null;
}

interface ProductScalarReferenceFormValues {
  name: string;
  categoryId: string | null;
}

interface ProductScalarReferenceRecord {
  id: string;
  name: string;
  categoryId: string | null;
}

/** What `transform.edit` hands back in the reference-diff test below — just
 * the two reference fields this test cares about, never a bare dictionary. */
interface LocationUpdatePayload {
  productId?: string;
  parentId?: string;
}

describe("useEntityFormController", () => {
  it("builds its resolver from the generated create/update schema map (not a hand-written one)", async () => {
    const props: EntityFormProps<
      { name: string },
      IngredientUpdatePayload,
      IngredientRecord
    > = {
      mode: "create",
      isPending: false,
      onCreate: vi.fn(),
    };
    // SAFETY test-only render: `useEntityFormController`'s generics are
    // pinned explicitly above/below so every `transform` callback's inferred
    // types line up without a cast.
    const { result } = renderHook(() => {
      const controller = useEntityFormController<
        "ingredient",
        IngredientFormValues,
        IngredientRecord,
        { name: string },
        IngredientUpdatePayload
      >("ingredient", props, {
        fields: ["name"],
        defaultValues: { name: "" },
        transform: {
          create: (values) => ({ name: values.name }),
          edit: (updates) => updates,
        },
      });
      // React Hook Form's `formState` only starts tracking a subfield (here,
      // `errors`) once something reads it during render — every real form
      // does this implicitly through `Controller`/`useController`, but this
      // headless test has to opt in explicitly to see `trigger()`'s result.
      void controller.form.formState.errors;
      return controller;
    });

    await act(async () => {
      await result.current.form.trigger();
    });

    // The server's own message, not a hand-rolled client string — proof the
    // resolver actually came from `entityFieldSchemaMaps`, not a permissive
    // fallback (a hand-written schema would say "Name is required").
    expect(result.current.form.formState.errors.name?.message).toBe(
      "Ingredient name is required",
    );
  });

  it("branches create vs edit, and skips onEdit when nothing changed", async () => {
    const onCreate = vi.fn();
    const createProps: EntityFormProps<
      { name: string },
      IngredientUpdatePayload,
      IngredientRecord
    > = { mode: "create", isPending: false, onCreate };
    // SAFETY test-only render: generics pinned explicitly, no cast needed.
    const { result: createResult } = renderHook(() =>
      useEntityFormController<
        "ingredient",
        IngredientFormValues,
        IngredientRecord,
        { name: string },
        IngredientUpdatePayload
      >("ingredient", createProps, {
        fields: ["name"],
        defaultValues: { name: "Flour" },
        transform: {
          create: (values) => ({ name: values.name }),
          edit: (updates) => updates,
        },
      }),
    );

    await act(async () => {
      await createResult.current.handleSubmit(
        createResult.current.form.getValues(),
      );
    });
    expect(onCreate).toHaveBeenCalledWith({ name: "Flour" });

    const record: IngredientRecord = { id: "ING-4K7M", name: "Flour" };
    const onEdit = vi.fn();
    const onCancel = vi.fn();
    const editProps: EntityFormProps<
      { name: string },
      IngredientUpdatePayload,
      IngredientRecord
    > = { mode: "edit", isPending: false, entity: record, onEdit, onCancel };
    // SAFETY test-only render: generics pinned explicitly, no cast needed.
    const { result: editResult } = renderHook(() =>
      useEntityFormController<
        "ingredient",
        IngredientFormValues,
        IngredientRecord,
        { name: string },
        IngredientUpdatePayload
      >("ingredient", editProps, {
        fields: ["name"],
        defaultValues: { name: record.name },
        transform: {
          create: (values) => ({ name: values.name }),
          edit: (updates) => updates,
        },
      }),
    );

    // No change: cancel, not edit.
    await act(async () => {
      await editResult.current.handleSubmit(
        editResult.current.form.getValues(),
      );
    });
    expect(onEdit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);

    // A real change: edit, with the diffed payload.
    act(() => {
      editResult.current.form.setValue("name", "Whole wheat flour");
    });
    await act(async () => {
      await editResult.current.handleSubmit(
        editResult.current.form.getValues(),
      );
    });
    expect(onEdit).toHaveBeenCalledWith({ name: "Whole wheat flour" });
  });

  it("discovers reference fields from the entity model and diffs only the one that changed", async () => {
    const record: LocationRecord = {
      id: "LOC-orig",
      name: "Garage",
      product: { id: "PRD-4K7M", name: "Bin" },
      parent: { id: "LOC-4K7M", name: "Garage shelf" },
    };
    const onEdit = vi.fn();
    const onCancel = vi.fn();
    const props: EntityFormProps<
      { name: string },
      LocationUpdatePayload,
      LocationRecord
    > = { mode: "edit", isPending: false, entity: record, onEdit, onCancel };

    // SAFETY test-only render: generics pinned explicitly, no cast needed.
    const { result } = renderHook(() =>
      useEntityFormController<
        "location",
        LocationFormValues,
        LocationRecord,
        { name: string },
        LocationUpdatePayload
      >("location", props, {
        fields: ["name", "productId", "parentId"],
        defaultValues: {
          name: record.name,
          product: record.product,
          parent: record.parent,
        },
        transform: {
          create: (values) => ({ name: values.name }),
          edit: (updates) => {
            const raw: unknown = updates;
            // SAFETY: `LocationRecord`'s reference fields are keyed
            // `product`/`parent` on read but `productId`/`parentId` on write —
            // this test's `transform.edit` passes the diffed write-side
            // updates through unchanged, which is exactly what it asserts on
            // below.
            return raw as LocationUpdatePayload;
          },
        },
      }),
    );

    // Reference metadata discovered from the field model, not hand-listed.
    expect(result.current.references.productId).toMatchObject({
      path: "product",
      entity: "product",
      nullable: true,
    });
    expect(result.current.references.parentId).toMatchObject({
      path: "parent",
      entity: "location",
      nullable: true,
    });

    // Only `parent` changes — `product` is re-set to the SAME id.
    act(() => {
      result.current.form.setValue("product", {
        id: "PRD-4K7M",
        name: "Bin",
      });
      result.current.form.setValue("parent", {
        id: "LOC-9K7M",
        name: "New shelf",
      });
    });

    await act(async () => {
      await result.current.handleSubmit(result.current.form.getValues());
    });

    expect(onCancel).not.toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledTimes(1);
    // SAFETY: `onEdit`'s single call above is this test's own `transform.edit`
    // identity function, which always returns a `LocationUpdatePayload`.
    const [updates] = onEdit.mock.calls[0] as [LocationUpdatePayload];
    expect(updates).toHaveProperty("parentId");
    expect(updates).not.toHaveProperty("productId");
  });

  it("keeps an opted-in reference ID scalar and records changes including clears", async () => {
    const record: ProductScalarReferenceRecord = {
      id: "PRD-4K7M",
      name: "Sample product",
      categoryId: "CAT-4K7M",
    };
    const onEdit = vi.fn();
    const props: EntityFormProps<
      { name: string; categoryId: string | null },
      Partial<ProductScalarReferenceRecord>,
      ProductScalarReferenceRecord
    > = { mode: "edit", isPending: false, entity: record, onEdit };

    const { result } = renderHook(() =>
      useEntityFormController<
        "product",
        ProductScalarReferenceFormValues,
        ProductScalarReferenceRecord,
        { name: string; categoryId: string | null },
        Partial<ProductScalarReferenceRecord>
      >("product", props, {
        fields: ["name", "categoryId"],
        referencePaths: { categoryId: null },
        defaultValues: { name: record.name, categoryId: record.categoryId },
        transform: {
          create: (values) => ({
            name: values.name,
            categoryId: values.categoryId,
          }),
          edit: (updates) => updates,
        },
      }),
    );

    // `categoryId` remains a generated scalar resolver field, not a sibling
    // combobox item whose missing value would make the resolver reject submit.
    expect(result.current.references.categoryId).toBeUndefined();

    act(() => {
      // EntityValueField emits an empty string when cleared.
      result.current.form.setValue("categoryId", "");
    });
    await act(async () => {
      await result.current.form.handleSubmit(result.current.handleSubmit)();
    });
    expect(onEdit).toHaveBeenCalledWith({ categoryId: null });
  });

  it("accepts a valid scalar reference on create", async () => {
    const onCreate = vi.fn();
    const props: EntityFormProps<
      { name: string; categoryId: string | null },
      Partial<ProductScalarReferenceRecord>,
      ProductScalarReferenceRecord
    > = { mode: "create", isPending: false, onCreate };

    const { result } = renderHook(() =>
      useEntityFormController<
        "product",
        ProductScalarReferenceFormValues,
        ProductScalarReferenceRecord,
        { name: string; categoryId: string | null },
        Partial<ProductScalarReferenceRecord>
      >("product", props, {
        fields: ["name", "categoryId"],
        referencePaths: { categoryId: null },
        defaultValues: { name: "Sample product", categoryId: "CAT-4K7M" },
        transform: {
          create: (values) => ({
            name: values.name,
            categoryId: values.categoryId,
          }),
          edit: (updates) => updates,
        },
      }),
    );

    await act(async () => {
      await result.current.form.handleSubmit(result.current.handleSubmit)();
    });
    expect(onCreate).toHaveBeenCalledWith({
      name: "Sample product",
      categoryId: "CAT-4K7M",
    });
  });
});
