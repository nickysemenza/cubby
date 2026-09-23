import { gardenEntryOut } from "@cubby/schemas/garden-entry";
import { productWithMappingsAndFoodOut } from "@cubby/schemas/product";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fromAny } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entityMutation } from "~/entities/entity-mutation.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";
import { entityBrowserMutationResultSchema } from "~/server/entity-kernel/contracts";

import {
  type EntityEditorPresentation,
  getEntityEditorPresentation,
} from "./editor-presentations";
import { EntityEditDialog } from "./entity-edit-dialog";
import {
  EntityEditorImages,
  staticSuggestionBasisFor,
} from "./entity-edit-dialog-content";
import type { EntityEditRequest } from "./types";
import { createEntityMutationPort } from "./use-entity-commands";
import { useEntityEditSession } from "./use-entity-edit-session";

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => {
  harness.dispose();
});

const image = (id: string, filename: string) => ({
  id,
  url: `https://example.com/${filename}`,
  filename,
  key: filename,
});

describe("editor presentation media hook", () => {
  const record = {
    ...mock(gardenEntryOut, {
      seed: 7,
      overrides: { images: [] },
    }),
    // A record image the shell's gallery already shows.
    images: [image("IMG-RECORD", "record.jpg")],
  };
  const request = {
    entity: "gardenEntry" as const,
    operation: "update" as const,
    intent: "full" as const,
    surface: "dialog" as const,
    record,
  };
  const media: NonNullable<EntityEditorPresentation<"gardenEntry">["media"]> = (
    input,
  ) => ({
    actions: (
      <button type="button">
        Identify from {input.pendingImages.length} pending
      </button>
    ),
    // The record image again (deduplicated) plus a second collection.
    extraExistingImages: [
      image("IMG-RECORD", "record.jpg"),
      image("IMG-LABEL", "label.jpg"),
    ],
    documents: <p>Manuals go here</p>,
  });

  function Harness() {
    const session = useEntityEditSession(request);
    const presentation = {
      ...getEntityEditorPresentation(request),
      media,
    };
    return (
      <EntityEditorImages
        entity="gardenEntry"
        operation="update"
        presentation={presentation}
        session={session}
        record={record}
        withRemoval
        withReorder={false}
        withPurposes={false}
      />
    );
  }

  it("renders the hook's actions and documents and merges its extra images once", () => {
    render(<Harness />, { wrapper: harness.wrapper });
    expect(
      screen.getByRole("button", { name: "Identify from 0 pending" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Manuals go here")).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: /^Remove record\.jpg$/ }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Remove label.jpg" }),
    ).toBeInTheDocument();
  });
});

describe("image block attachment roles", () => {
  // Product is the one gallery whose attachments carry roles; the block
  // offers the role select only for it.
  const record = {
    ...mock(productWithMappingsAndFoodOut, {
      seed: 8,
      overrides: { images: [], unitMappings: [] },
    }),
    images: [{ ...image("IMG-RECORD", "record.jpg"), purpose: "item" }],
  };
  const request = {
    entity: "product" as const,
    operation: "update" as const,
    intent: "full" as const,
    surface: "dialog" as const,
    record,
  };

  function Harness() {
    const session = useEntityEditSession(request);
    return (
      <>
        <EntityEditorImages
          entity="product"
          operation="update"
          presentation={getEntityEditorPresentation(request)}
          session={session}
          record={record}
          withRemoval
          withReorder={false}
          withPurposes
        />
        <output data-testid="image-fields">
          {JSON.stringify({
            pendingImageIds: session.form.watch("pendingImageIds"),
            pendingImagePurposes: session.form.watch("pendingImagePurposes"),
          })}
        </output>
      </>
    );
  }

  // The attachment-role contract `useImageState` documented: a role correction
  // on an existing image rides `pendingImageIds` alongside its purpose, so
  // the repository applies the role without detaching the image.
  it("writes a role correction into pendingImagePurposes and pendingImageIds", () => {
    render(<Harness />, { wrapper: harness.wrapper });
    fireEvent.change(screen.getByLabelText("Attachment role for record.jpg"), {
      target: { value: "label" },
    });
    expect(screen.getByTestId("image-fields")).toHaveTextContent(
      JSON.stringify({
        pendingImageIds: ["IMG-RECORD"],
        pendingImagePurposes: { "IMG-RECORD": "label" },
      }),
    );
  });
});

describe("EntityEditDialog thrown submit errors", () => {
  // The kernel validates only what the registry declares (required, custom
  // `validate`); a value the generated update schema then rejects used to
  // throw out of `submit()` as an unhandled rejection the dialog never showed.
  it("shows a build failure in the banner and beside its field instead of swallowing it", async () => {
    const transport = vi.fn(async () =>
      entityBrowserMutationResultSchema.parse({
        action: "update",
        entity: "task",
        item: {},
        sideEffects: { backgroundBatches: [] },
      }),
    );
    const mutation = entityMutation.mutate.withTransport(transport);
    const mutationPort = createEntityMutationPort({
      execute: (command) => mutation.forEntity(command.entity).call(command),
    });
    const record = {
      id: testShortcode("task", "TSK-TEST"),
      name: "Laundry",
      status: "not_started",
      dueDate: "2026-08-20",
    };
    const request: Omit<EntityEditRequest<"task", "update">, "surface"> & {
      intent: "schedule";
    } = {
      entity: "task",
      operation: "update",
      intent: "schedule",
      record: fromAny(record),
      // Not one of `status`'s options: only the update schema catches it.
      seed: fromAny({ status: "bogus" }),
    };
    render(
      <EntityEditDialog
        open
        onOpenChange={vi.fn()}
        mutationPort={mutationPort}
        request={request}
      />,
      { wrapper: harness.wrapper },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Save changes" }),
    );
    await waitFor(() =>
      expect(screen.getAllByText(/Invalid option/).length).toBeGreaterThan(0),
    );
    expect(screen.getByText(/at status/)).toBeInTheDocument();
    expect(transport).not.toHaveBeenCalled();
  });
});

describe("static suggestion basis", () => {
  // A suggest target's basis may name a record-only field the intent never
  // renders (product `categoryId` ← `classificationEvidence`); the provider
  // can only watch form paths, so that value has to be fixed off the record.
  it("takes basis keys outside the intent roster off the record, and nothing when every key is rendered", () => {
    const productFields = [
      "name",
      "manufacturer",
      "model",
      "notes",
      "categoryId",
    ];
    expect(
      staticSuggestionBasisFor("product", productFields, {
        id: "PRD-TEST",
        classificationEvidence: "Ring-bound sketchbook, 9x12",
      }),
    ).toEqual({ classificationEvidence: "Ring-bound sketchbook, 9x12" });
    expect(
      staticSuggestionBasisFor(
        "product",
        [...productFields, "classificationEvidence"],
        { id: "PRD-TEST", classificationEvidence: "evidence" },
      ),
    ).toBeUndefined();
    expect(
      staticSuggestionBasisFor("product", productFields, undefined),
    ).toBeUndefined();
  });
});
