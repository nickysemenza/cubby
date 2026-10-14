import { ClipboardTextIcon } from "@phosphor-icons/react/dist/csr/ClipboardText";
import { createFileRoute } from "@tanstack/react-router";

import {
  ControlsSection,
  FeedbackSection,
  FoundationsSection,
} from "~/app/design/sections/basics-section";
import {
  LocationTreeSection,
  RecipeUnitsSection,
} from "~/app/design/sections/household-section";
import { PickerSection } from "~/app/design/sections/picker-section";
import { RecordsSection } from "~/app/design/sections/records-section";
import { RTableSection } from "~/app/design/sections/rtable-section";
import { ValuesSection } from "~/app/design/sections/values-section";
import { pageTitle } from "~/lib/page-title";
import { Stack } from "~/ui/layout";
import { Page } from "~/ui/page/Page";
import { Button } from "~/ui/primitives/button";

export const Route = createFileRoute("/_authenticated/design")({
  head: () => ({ meta: [{ title: pageTitle("Design system") }] }),
  component: DesignSystem,
});

const PROJECT_STATS = [
  { label: "Tasks", value: "5 / 8" },
  { label: "Purchases", value: "3" },
  { label: "Recorded spend", value: "$420.00" },
];

/** In page order; the signature components follow the foundations. */
const SECTIONS = [
  ["foundations", "Foundations"],
  ["picker", "Picker"],
  ["records", "Records"],
  ["rtable", "RTable"],
  ["location-tree", "LocationTree"],
  ["values", "Dates, pills, filters"],
  ["recipe-units", "Recipe text, units"],
  ["controls", "Controls"],
  ["feedback", "Feedback"],
] as const;

function DesignSystem() {
  return (
    <Page
      variant="detail"
      entity="project"
      title="Illustrative project detail"
      heroNo="PRJ-4K7M"
      rawData={{ createdAt: "2026-01-15T12:00:00Z" }}
      heroStamp={{ label: "In progress" }}
      heroStats={PROJECT_STATS}
      heroActions={{
        primary: (
          <Button variant="outline" size="sm">
            <ClipboardTextIcon />
            Review
          </Button>
        ),
      }}
    >
      <Stack gap="lg">
        <nav
          aria-label="Design sections"
          className="flex flex-wrap gap-x-3 gap-y-1 text-xs"
        >
          {SECTIONS.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {label}
            </a>
          ))}
        </nav>
        <FoundationsSection />
        <PickerSection />
        <RecordsSection />
        <RTableSection />
        <LocationTreeSection />
        <ValuesSection />
        <RecipeUnitsSection />
        <ControlsSection />
        <FeedbackSection />
      </Stack>
    </Page>
  );
}
