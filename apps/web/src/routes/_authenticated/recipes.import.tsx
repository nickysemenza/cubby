import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import { CookbookImport } from "~/app/_components/recipe/cookbook-import";
import { NotionImport } from "~/app/_components/recipe/notion-import";
import { Page } from "~/components/page/Page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { useTabParam } from "~/hooks/useTabParam";
import { pageTitle } from "~/lib/page-title";

const searchSchema = z.object({
  // Active tab, deep-linkable. Default ("cookbook") is omitted from the URL.
  tab: z.enum(["cookbook", "notion"]).optional().catch(undefined),
  // `?from=<cookbookId>` re-opens that cookbook's stored extraction for
  // selective re-import (the "Add from source" path); absent for the normal
  // drag-EPUB flow. When present it forces the cookbook tab.
  from: z.string().optional(),
});

export const Route = createFileRoute("/_authenticated/recipes/import")({
  validateSearch: searchSchema,
  component: ImportPage,
  head: () => ({ meta: [{ title: pageTitle("Import recipes") }] }),
});

function ImportPage() {
  const { tab, from } = Route.useSearch();
  const navigate = useNavigate();

  // A `from` link always targets the cookbook re-importer, so force that tab.
  // Switching to Notion drops `from` — otherwise the force would pin the
  // cookbook tab and the click would appear to do nothing.
  const activeTab = from ? "cookbook" : tab;

  // NotionImport reads the whole Notion recipes DB when first mounted, so it
  // must NOT mount while hidden behind the default cookbook tab. Activate on
  // first visit to the tab, then keep it mounted (sticky) so its cached preview
  // and any in-flight import survive switching back to the cookbook tab.
  const [notionActivated, setNotionActivated] = useState(
    activeTab === "notion",
  );

  const tabs = useTabParam(activeTab, "cookbook", (next) => {
    if (next === "notion") setNotionActivated(true);
    navigate({
      to: ".",
      search: (prev) => ({
        ...prev,
        tab: next,
        from: next === "notion" ? undefined : prev.from,
      }),
    });
  });

  return (
    <Page
      variant="list"
      title="Import recipes"
      eyebrow="Recipes"
      compact
      decoration="none"
    >
      <Tabs value={tabs.value} onValueChange={tabs.onValueChange}>
        <TabsList variant="line">
          <TabsTrigger value="cookbook">Cookbook</TabsTrigger>
          <TabsTrigger value="notion">Notion</TabsTrigger>
        </TabsList>
        {/* Both panels keepMounted: CookbookImport holds minutes of
            component-local extraction state + a beforeunload guard, so
            switching tabs must not unmount it. NotionImport additionally
            renders nothing until first activated (see notionActivated). */}
        <TabsContent value="cookbook" keepMounted>
          <CookbookImport loadCookbookId={from} />
        </TabsContent>
        <TabsContent value="notion" keepMounted>
          {notionActivated ? <NotionImport /> : null}
        </TabsContent>
      </Tabs>
    </Page>
  );
}
