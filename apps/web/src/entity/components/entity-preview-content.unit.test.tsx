import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { metadataQueryClient } from "#web/tests/entity-metadata.ts";
import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";
const infLocation = entityFieldEnvelopeSchemas.location.detail;
const plantingOut = entityFieldEnvelopeSchemas.planting.detail;
const projectOut = entityFieldEnvelopeSchemas.project.detail;

import { testShortcode } from "@cubby/schemas/testing";
import {
  cleanup,
  fireEvent,
  render as testingRender,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { entityPreviewQueryOptions } from "~/entity/entity-query";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { PreviewQuery } from "../preview/preview-query";
import { manifestPreviewCard } from "./entity-preview-content";

let queryClient: Awaited<ReturnType<typeof metadataQueryClient>>;
beforeEach(async () => {
  queryClient = await metadataQueryClient();
});
afterEach(() => {
  cleanup();
  queryClient.clear();
});

function MetadataProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function render(ui: ReactNode, options?: Parameters<typeof testingRender>[1]) {
  const BrowserWrapper = options?.wrapper;
  return testingRender(ui, {
    ...options,
    wrapper: ({ children }) =>
      BrowserWrapper ? (
        <BrowserWrapper>
          <MetadataProvider>{children}</MetadataProvider>
        </BrowserWrapper>
      ) : (
        <MetadataProvider>{children}</MetadataProvider>
      ),
  });
}

const withMedia = <T extends { fields: { displayImages: unknown } }>(
  value: T,
  url?: string,
) => ({
  ...value,
  fields: {
    ...value.fields,
    displayImages: fieldValueFixture(
      entityFieldEnvelopeSchemas.project.detail.shape.fields.shape
        .displayImages,
      url ? [{ id: testShortcode("image", "IMG-PREVIEW"), url }] : [],
    ),
  },
  attachments: [],
});

let harness: ReturnType<typeof createBrowserTestHarness>;
beforeEach(() => {
  harness = createBrowserTestHarness();
});
afterEach(() => harness.dispose());

describe("PreviewQuery", () => {
  it("distinguishes loading, failure, deletion, and success states", () => {
    const refetch = vi.fn();
    const { rerender } = render(
      <PreviewQuery
        query={{ data: undefined, isLoading: true, isError: false, refetch }}
        label="Product"
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    rerender(
      <PreviewQuery
        query={{
          data: undefined,
          isLoading: false,
          isError: true,
          error: new Error("preview transport down"),
          refetch,
        }}
        label="Product"
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByText("Couldn't load Product.")).toBeInTheDocument();
    // The raw failure rides along, never a generic-only line.
    expect(screen.getByText("preview transport down")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledOnce();

    rerender(
      <PreviewQuery
        query={{ data: undefined, isLoading: false, isError: false, refetch }}
        label="Product"
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByText("Product (deleted)")).toBeInTheDocument();

    rerender(
      <PreviewQuery
        query={{
          data: { name: "Olive oil" },
          isLoading: false,
          isError: false,
          refetch,
        }}
        label="Product"
      >
        {(data) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(screen.getByText("Olive oil")).toBeInTheDocument();
  });

  it("clears record-owned controls while unavailable", () => {
    const onUnavailable = vi.fn();
    const { rerender } = render(
      <PreviewQuery
        query={{
          data: { name: "Olive oil" },
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }}
        label="Product"
        onUnavailable={onUnavailable}
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(onUnavailable).not.toHaveBeenCalled();

    rerender(
      <PreviewQuery
        query={{
          data: undefined,
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        }}
        label="Product"
        onUnavailable={onUnavailable}
      >
        {(data: { name: string }) => <span>{data.name}</span>}
      </PreviewQuery>,
    );
    expect(onUnavailable).toHaveBeenCalledOnce();
  });
});

// The hovercard's image is a `{kind:"thumb"}` body block — ManifestCard draws
// nothing without one, which is how every location rendered an imageless card
// while its photo sat unread on the wire.

describe("manifestPreviewCard", () => {
  it("titles from the declared titleField and reads its hero chip as identity", () => {
    const tomato = mock(plantingOut, {
      seed: 8,
      overrides: {
        fields: {
          status: fieldValueFixture(
            entityFieldEnvelopeSchemas.planting.detail.shape.fields.shape[
              "status"
            ],
            "growing",
          ),
        },
        locationId: testShortcode("location", "LOC-4K7M"),
        locationName: "Raised bed 2",

        displayName: "Tomato · Cherokee Purple",
      },
    });

    const card = manifestPreviewCard(
      queryClient,
      "planting",
      withMedia(tomato),
    );

    expect(card.name).toBe("Tomato · Cherokee Purple");
    expect(card.identity).toBe("Growing");
  });

  // A reference fact renders the resolved name, not the raw shortcode, and
  // resolves through the detail cache when the projection carries no name.
  it.each([
    { locationName: "Raised bed 2", shown: "Raised bed 2" },
    { locationName: null, shown: "Synthetic resolved bed" },
  ])("renders a reference fact as $shown", ({ locationName, shown }) => {
    const tomato = mock(plantingOut, {
      seed: 8,
      overrides: {
        fields: {
          status: fieldValueFixture(
            entityFieldEnvelopeSchemas.planting.detail.shape.fields.shape[
              "status"
            ],
            "growing",
          ),
        },
        locationId: testShortcode("location", "LOC-4K7M"),
        locationName,

        displayName: "Tomato · Cherokee Purple",
      },
    });

    queryClient.setQueryData(
      entityPreviewQueryOptions("location", "LOC-4K7M").queryKey,
      { id: "LOC-4K7M", name: "Synthetic resolved bed", displayImages: [] },
    );
    const card = manifestPreviewCard(
      queryClient,
      "planting",
      withMedia(tomato),
    );
    const stats = card.body?.find((block) => block.kind === "stats");
    if (stats?.kind !== "stats") throw new Error("expected a stats block");
    const location = stats.stats.find((stat) => stat.label === "Location");
    if (!location) throw new Error("expected a Location fact");
    render(<>{location.value}</>, { wrapper: harness.wrapper });
    expect(screen.getByText(shown)).toBeInTheDocument();
  });

  // A declared `display.preview` roster is the whole card, in model order —
  // the project rollups arrive as projection fields, not a web-side map.
  it("shows exactly the declared preview facts", () => {
    const project = mock(projectOut, {
      seed: 3,
      overrides: {
        fields: {
          taskProgress: fieldValueFixture(
            entityFieldEnvelopeSchemas.project.detail.shape.fields.shape[
              "taskProgress"
            ],
            "3/5",
          ),
          spent: fieldValueFixture(
            entityFieldEnvelopeSchemas.project.detail.shape.fields.shape.spent,
            120,
          ),
        },
        costEstimate: 500,
      },
    });

    const card = manifestPreviewCard(
      queryClient,
      "project",
      withMedia(project),
    );
    const stats = card.body?.find((block) => block.kind === "stats");
    if (stats?.kind !== "stats") throw new Error("expected a stats block");
    expect(stats.stats.map((stat) => stat.label)).toEqual([
      "Cost estimate",
      "Spent",
      "Tasks",
    ]);
  });

  it("leads with the cover image and links the breadcrumb parent", () => {
    const parent = mock(infLocation, {
      seed: 1,
      overrides: {
        fields: {
          type: fieldValueFixture(
            entityFieldEnvelopeSchemas.location.detail.shape.fields.shape[
              "type"
            ],
            "room",
          ),
          product: fieldValueFixture(
            entityFieldEnvelopeSchemas.location.detail.shape.fields.shape[
              "product"
            ],
            null,
          ),
        },
        name: "Garage",
      },
    });
    const bin = mock(infLocation, {
      seed: 2,
      overrides: {
        fields: {
          type: fieldValueFixture(
            entityFieldEnvelopeSchemas.location.detail.shape.fields.shape[
              "type"
            ],
            "area",
          ),
          product: fieldValueFixture(
            entityFieldEnvelopeSchemas.location.detail.shape.fields.shape[
              "product"
            ],
            null,
          ),
        },
        name: "garbage bin area",

        parent,
      },
    });

    const card = manifestPreviewCard(
      queryClient,
      "location",
      withMedia(bin, "https://example.com/bin.jpg"),
    );

    expect(card.body?.[0]).toEqual({
      kind: "thumb",
      url: "https://example.com/bin.jpg",
    });
    expect(card.crossLinks).toEqual([
      expect.objectContaining({
        to: "/locations/$shortcode",
        params: { shortcode: parent.id },
        label: "Garage",
      }),
    ]);
  });
});
