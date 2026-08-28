import { integrityCatalogSchema } from "@cubby/schemas/entity-integrity";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  entityIntegrity,
  integrityProblems,
} from "~/entities/entity-integrity.functions";
import { createBrowserTestHarness } from "~/lib/test/browser-harness";

import {
  type EntityIntegrityOperations,
  EntityIntegrityTab,
} from "./EntityIntegrityTab";

const emptyCatalog = integrityCatalogSchema.parse({
  coverage: {
    relationships: 0,
    incomingEdges: 0,
    auditedEdges: 0,
    exemptEdges: 0,
    operations: 0,
  },
  entities: [],
  operations: [],
});

let harness: ReturnType<typeof createBrowserTestHarness>;

beforeEach(() => {
  harness = createBrowserTestHarness();
});

afterEach(() => {
  harness.dispose();
});

function integrityOperations(onCatalog: () => void, onViolations: () => void) {
  return {
    catalog: entityIntegrity.catalog.withTransport(async () => {
      onCatalog();
      return emptyCatalog;
    }),
    referentialLiveness: integrityProblems.getByType.withTransport(async () => {
      onViolations();
      return {
        type: "referentialLivenessViolations",
        items: [],
        total: 0,
      };
    }),
  } satisfies EntityIntegrityOperations;
}

describe("EntityIntegrityTab", () => {
  it("renders catalog coverage with the focused live-violation operation only", async () => {
    let catalogCalls = 0;
    let violationCalls = 0;
    render(
      <EntityIntegrityTab
        operations={integrityOperations(
          () => {
            catalogCalls += 1;
          },
          () => {
            violationCalls += 1;
          },
        )}
      />,
      { wrapper: harness.wrapper },
    );

    expect(
      await screen.findByText(
        "One node per entity — click a node (or a chip below) to inspect its relationships, incoming edges, and lifecycle dispositions.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Live violations")).toBeVisible();
    await waitFor(() => expect(catalogCalls).toBe(1));
    await waitFor(() => expect(violationCalls).toBe(1));
  });
});
