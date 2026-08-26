import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Mock } from "vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(
  (): {
    preview: Mock<(props: unknown) => void>;
    relationships: Mock<(props: unknown) => void>;
    activity: Mock<(props: unknown) => void>;
  } => ({
    preview: vi.fn(),
    relationships: vi.fn(),
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

vi.mock("./audit-log/audit-log-list", () => ({
  AuditLogList: (props: unknown) => {
    mocks.activity(props);
    return <div data-testid="audit-log" />;
  },
}));

import { EntityWorkbenchInspector } from "./entity-workbench-inspector";

const VENDOR_ID = "VEN-WORKBENCH";
const IMAGE_ID = "IMG-WORKBENCH";

describe("EntityWorkbenchInspector", () => {
  beforeEach(() => {
    mocks.preview.mockClear();
    mocks.relationships.mockClear();
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
    });
    expect(mocks.relationships).not.toHaveBeenCalled();
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

  it("uses an identity-only fallback for an unsupported compact entity", () => {
    render(<EntityWorkbenchInspector entity="image" id={IMAGE_ID} />);

    expect(screen.queryByTestId("compact-preview")).not.toBeInTheDocument();
    expect(
      screen.getByText("Open the full record to inspect its details."),
    ).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Relations" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Activity" })).toBeNull();
    const openLink = screen.getByLabelText("Open full image details");
    expect(openLink.tagName).toBe("A");
    expect(openLink).toHaveAttribute("data-router-link", "true");
  });
});
