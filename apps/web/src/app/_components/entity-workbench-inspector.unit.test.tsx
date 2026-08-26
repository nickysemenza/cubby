import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(
  (): {
    preview: Mock<(props: unknown) => void>;
    relationships: Mock<(props: unknown) => void>;
    relationshipRoute: Mock<(props: unknown) => void>;
    activity: Mock<(props: unknown) => void>;
  } => ({
    preview: vi.fn(),
    relationships: vi.fn(),
    relationshipRoute: vi.fn(),
    activity: vi.fn(),
  }),
);

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    ...props
  }: {
    children?: ReactNode;
    to: string;
    params?: { id?: string; shortcode?: string };
    [key: string]: unknown;
  }) => (
    <a
      {...props}
      data-router-link="true"
      href={to
        .replace("$id", params?.id ?? "")
        .replace("$shortcode", params?.shortcode ?? "")}
    >
      {children}
    </a>
  ),
}));

vi.mock("./EntityPreviewContent", () => ({
  EntityPreviewContent: (props: unknown) => {
    mocks.preview(props);
    return <div data-testid="compact-preview" />;
  },
}));

vi.mock("./relationships/relationship-explorer", () => ({
  RelationshipExplorer: (props: unknown) => {
    mocks.relationships(props);
    return <div data-testid="relationship-explorer" />;
  },
}));

vi.mock("./relationships/relationship-route-preview", () => ({
  RelationshipRoutePreview: (props: unknown) => {
    mocks.relationshipRoute(props);
    return <div data-testid="relationship-route-preview" />;
  },
}));

vi.mock("./audit-log/audit-log-list", () => ({
  AuditLogList: (props: unknown) => {
    mocks.activity(props);
    return <div data-testid="audit-log" />;
  },
}));

import { EntityWorkbenchInspector } from "./entity-workbench-inspector";

const VENDOR_ID = "VEN-WORKBENCH";
const IMAGE_ID = "IMG-WORKBENCH";
const LEDGER_PARTY_ID = "LPY-WORKBENCH";
const PRODUCT_ID = "PRD-WORKBENCH";

describe("EntityWorkbenchInspector", () => {
  beforeEach(() => {
    mocks.preview.mockClear();
    mocks.relationships.mockClear();
    mocks.relationshipRoute.mockClear();
    mocks.activity.mockClear();
  });

  it("keeps the compact overview mounted alone until its tab is selected", () => {
    const onClose = vi.fn();
    render(
      <EntityWorkbenchInspector
        entity="vendor"
        id={VENDOR_ID}
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId("compact-preview")).toBeInTheDocument();
    expect(mocks.preview).toHaveBeenCalledWith({
      entity: "vendor",
      id: VENDOR_ID,
      showOpenAction: false,
    });
    expect(mocks.relationships).not.toHaveBeenCalled();
    expect(mocks.relationshipRoute).toHaveBeenCalledWith({
      entity: "vendor",
      sourceId: VENDOR_ID,
    });
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Relations" })).toBeVisible();
    expect(screen.getByRole("tab", { name: "Activity" })).toBeVisible();

    const openLink = screen.getByLabelText("Open full vendor details");
    expect(openLink.tagName).toBe("A");
    expect(openLink).toHaveAttribute("data-router-link", "true");
    expect(openLink).toHaveAttribute("href", `/vendors/${VENDOR_ID}`);

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.getByTestId("relationship-explorer")).toBeInTheDocument();
    expect(mocks.relationships).toHaveBeenCalledWith({
      entity: "vendor",
      sourceId: VENDOR_ID,
    });

    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(screen.getByTestId("audit-log")).toBeInTheDocument();
    expect(mocks.activity).toHaveBeenCalledWith({
      entityType: "vendor",
      entityId: VENDOR_ID,
      showEntityLink: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Close inspector" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses a compact overview for a first-wave image entity", () => {
    render(<EntityWorkbenchInspector entity="image" id={IMAGE_ID} />);

    expect(screen.getByTestId("compact-preview")).toBeInTheDocument();
    expect(mocks.preview).toHaveBeenCalledWith({
      entity: "image",
      id: IMAGE_ID,
      showOpenAction: false,
    });
    const openLink = screen.getByLabelText("Open full image details");
    expect(openLink.tagName).toBe("A");
    expect(openLink).toHaveAttribute("data-router-link", "true");
    expect(mocks.relationshipRoute).not.toHaveBeenCalled();
  });

  it("does not mount the generic relationship path for Product", () => {
    render(<EntityWorkbenchInspector entity="product" id={PRODUCT_ID} />);

    expect(mocks.relationshipRoute).not.toHaveBeenCalled();
    expect(screen.queryByRole("tab", { name: "Relations" })).toBeNull();
  });

  it("does not promise an unavailable full record for a route-less fallback", () => {
    render(
      <EntityWorkbenchInspector entity="ledgerParty" id={LEDGER_PARTY_ID} />,
    );

    expect(screen.queryByTestId("compact-preview")).not.toBeInTheDocument();
    expect(
      screen.getByText("Use Relations or Activity to inspect linked records."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /open full/i })).toBeNull();
  });

  it("resets to Overview when the selected record changes", () => {
    const { rerender } = render(
      <EntityWorkbenchInspector entity="vendor" id={VENDOR_ID} />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Relations" }));
    expect(screen.getByTestId("relationship-explorer")).toBeInTheDocument();

    rerender(
      <EntityWorkbenchInspector entity="ledgerParty" id={LEDGER_PARTY_ID} />,
    );

    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByTestId("relationship-explorer")).toBeNull();
    expect(
      screen.getByText("Use Relations or Activity to inspect linked records."),
    ).toBeVisible();
  });
});
