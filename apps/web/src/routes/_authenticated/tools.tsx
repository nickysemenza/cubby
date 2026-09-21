import type { ToolGalleryGroupBy } from "@cubby/schemas/project";
import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { Grid2X2, Grid3X3, PanelsTopLeft, TableProperties } from "lucide-react";
import { useCallback, useState } from "react";

import { ToolMatrixPage } from "~/app/projects/tool-matrix-page";
import {
  ToolGalleryPage,
  type ToolGalleryPresentation,
} from "~/app/tools/tool-gallery-page";
import {
  matrixSearchFromTools,
  type ToolMatrixSearch,
  toolsSearchSchema,
} from "~/app/tools/tool-search";
import { Page } from "~/components/page/Page";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { pageTitle } from "~/lib/page-title";

type ToolsView = ToolGalleryPresentation | "usage";

const VIEW_OPTIONS: ViewSwitcherOption<ToolsView>[] = [
  { value: "cards", label: "Cards", icon: Grid2X2 },
  { value: "compact", label: "Compact", icon: Grid3X3 },
  { value: "flow", label: "Flow", icon: PanelsTopLeft },
  { value: "usage", label: "Usage", icon: TableProperties },
];

export const Route = createFileRoute("/_authenticated/tools")({
  validateSearch: toolsSearchSchema,
  search: {
    middlewares: [
      stripSearchParams({
        view: "gallery",
        galleryGroup: "location",
        floor: 100,
        usageGroup: "trade",
        page: 1,
      }),
    ],
  },
  component: ToolsPage,
  head: () => ({ meta: [{ title: pageTitle("Tools") }] }),
});

function ToolsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const view = search.view ?? "gallery";
  const [presentation, setPresentation] =
    useState<ToolGalleryPresentation>("cards");

  const changeGalleryQuery = useCallback(
    (query: string | undefined) => {
      void navigate({
        search: (previous) => ({ ...previous, q: query, section: undefined }),
        replace: true,
      });
    },
    [navigate],
  );
  const changeGalleryGroup = useCallback(
    (galleryGroup: ToolGalleryGroupBy) => {
      void navigate({
        search: (previous) => ({
          ...previous,
          galleryGroup,
          section: undefined,
        }),
        replace: true,
      });
    },
    [navigate],
  );
  const changeGallerySection = useCallback(
    (section: string | undefined) => {
      void navigate({
        search: (previous) => ({ ...previous, section }),
        replace: true,
      });
    },
    [navigate],
  );
  const changeMatrixSearch = useCallback(
    (next: Partial<ToolMatrixSearch>) => {
      const { group, ...matrix } = next;
      void navigate({
        search: (previous) => {
          const updated = { ...previous, ...matrix };
          if (Object.hasOwn(next, "group")) updated.usageGroup = group;
          return updated;
        },
        replace: true,
      });
    },
    [navigate],
  );

  return (
    <Page
      variant="list"
      listChrome="workbench"
      title="Tools"
      eyebrow="House"
      layout="full"
      bodyGutter="none"
      workbenchControls={
        <ViewSwitcher
          ariaLabel="Tools view"
          options={VIEW_OPTIONS}
          value={view === "gallery" ? presentation : "usage"}
          onValueChange={(nextView) => {
            if (nextView !== "usage") setPresentation(nextView);
            void navigate({
              search: (previous) => ({
                ...previous,
                view: nextView === "usage" ? "usage" : "gallery",
              }),
              replace: true,
            });
          }}
          compactOnMobile
        />
      }
    >
      {view === "gallery" ? (
        <div className="px-2 py-3 md:px-6 md:py-4">
          <ToolGalleryPage
            presentation={presentation}
            query={search.q ?? ""}
            groupBy={search.galleryGroup ?? "location"}
            section={search.section}
            onQueryChange={changeGalleryQuery}
            onGroupByChange={changeGalleryGroup}
            onSectionChange={changeGallerySection}
          />
        </div>
      ) : (
        <ToolMatrixPage
          search={matrixSearchFromTools(search)}
          onSearchChange={changeMatrixSearch}
        />
      )}
    </Page>
  );
}
