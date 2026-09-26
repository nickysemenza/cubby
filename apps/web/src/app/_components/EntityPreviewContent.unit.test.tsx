import { imageWithEntitySchema } from "@cubby/schemas/image";
import { infLocation } from "@cubby/schemas/location";
import { plantingOut } from "@cubby/schemas/planting";
import { projectOut } from "@cubby/schemas/project";
import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserTestHarness } from "~/lib/test/browser-harness";
import { mock } from "~/lib/test/mock-schema";

import { manifestPreviewCard, toImageCard } from "./EntityPreviewContent";
import { PreviewQuery } from "./preview/preview-query";

const withMedia = <T,>(value: T, url?: string) => ({
  ...value,
  displayImages: url
    ? [{ id: testShortcode("image", "IMG-PREVIEW"), url }]
    : [],
  attachments: [],
  redirectedFrom: null,
  previousShortcodes: [],
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
        locationId: testShortcode("location", "LOC-4K7M"),
        locationName: "Raised bed 2",
        status: "growing",
        displayName: "Tomato · Cherokee Purple",
      },
    });

    const card = manifestPreviewCard("planting", withMedia(tomato));

    expect(card.name).toBe("Tomato · Cherokee Purple");
    expect(card.identity).toBe("Growing");
  });

  // A reference fact renders the resolved name, not the raw shortcode, and
  // falls back to the shortcode when the projection carries no name.
  it.each([
    { locationName: "Raised bed 2", shown: "Raised bed 2" },
    { locationName: null, shown: "LOC-4K7M" },
  ])("renders a reference fact as $shown", ({ locationName, shown }) => {
    const tomato = mock(plantingOut, {
      seed: 8,
      overrides: {
        locationId: testShortcode("location", "LOC-4K7M"),
        locationName,
        status: "growing",
        displayName: "Tomato · Cherokee Purple",
      },
    });

    const card = manifestPreviewCard("planting", withMedia(tomato));
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
      overrides: { costEstimate: 500, spent: 120, taskProgress: "3/5" },
    });

    const card = manifestPreviewCard("project", withMedia(project));
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
      overrides: { name: "Garage", type: "room", product: null },
    });
    const bin = mock(infLocation, {
      seed: 2,
      overrides: {
        name: "garbage bin area",
        type: "area",
        product: null,
        parent,
      },
    });

    const card = manifestPreviewCard(
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

describe("toImageCard", () => {
  it("shows every existing image association without a second query", () => {
    const image = mock(imageWithEntitySchema, {
      seed: 7,
      overrides: {
        filename: "workbench.jpg",
        status: "UPLOADED",
        width: 1600,
        height: 1200,
        associations: [
          {
            entityType: "product",
            entityId: testShortcode("product", "PRD-4K7M"),
            entityName: "Bench lamp",
            role: "cover",
          },
          {
            entityType: "project",
            entityId: testShortcode("project", "PRJ-7M2X"),
            entityName: "Workshop refresh",
            role: "attachment",
          },
        ],
      },
    });

    const card = toImageCard(withMedia(image, image.url));

    expect(card.crossLinks).toEqual([
      expect.objectContaining({
        to: "/products/$shortcode",
        params: { shortcode: "PRD-4K7M" },
        label: "Bench lamp · cover",
      }),
      expect.objectContaining({
        to: "/projects/$shortcode",
        params: { shortcode: "PRJ-7M2X" },
        label: "Workshop refresh · attachment",
      }),
    ]);
    expect(card.body).toEqual(
      expect.arrayContaining([
        { kind: "thumb", url: image.url },
        {
          kind: "stats",
          stats: [
            { label: "Dimensions", value: "1600 × 1200" },
            { label: "Associations", value: 2 },
          ],
        },
      ]),
    );
  });
});
