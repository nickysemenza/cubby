import { CalendarBlankIcon } from "@phosphor-icons/react/dist/csr/CalendarBlank";
import { CaretUpDownIcon } from "@phosphor-icons/react/dist/csr/CaretUpDown";
import { ChatCircleTextIcon } from "@phosphor-icons/react/dist/csr/ChatCircleText";
import { ClipboardTextIcon } from "@phosphor-icons/react/dist/csr/ClipboardText";
import { CookingPotIcon } from "@phosphor-icons/react/dist/csr/CookingPot";
import { ListBulletsIcon } from "@phosphor-icons/react/dist/csr/ListBullets";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/dist/csr/SlidersHorizontal";
import { TableIcon } from "@phosphor-icons/react/dist/csr/Table";
import { TreeStructureIcon } from "@phosphor-icons/react/dist/csr/TreeStructure";
import { createFileRoute } from "@tanstack/react-router";

import { Page } from "~/entity/page/page";
import { ComponentsLine } from "~/features/design/components/design-section";
import {
  ControlsSection,
  FeedbackSection,
  FoundationsSection,
} from "~/features/design/sections/basics-section";
import {
  LocationTreeSection,
  RecipeUnitsSection,
} from "~/features/design/sections/household-section";
import { PickerSection } from "~/features/design/sections/picker-section";
import { RecordsSection } from "~/features/design/sections/records-section";
import { RTableSection } from "~/features/design/sections/rtable-section";
import { ValuesSection } from "~/features/design/sections/values-section";
import { pageTitle } from "~/lib/page-title";
import {
  IndexedSections,
  type IndexedSectionGroup,
} from "~/ui/data-table/indexed-sections";
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

/** The same contents index record details use; `#<section id>` and `#<group key>` link in. */
const GROUPS: IndexedSectionGroup[] = [
  {
    id: "detail-group-signature",
    title: "Signature components",
    sections: [
      {
        id: "picker",
        title: "Picker",
        icon: CaretUpDownIcon,
        overflowVisible: true,
        description: (
          <ComponentsLine
            components={[
              "Picker",
              "PickerField",
              "PickerVisual",
              "PickerOption",
            ]}
            source={[
              "ui/combobox/picker.tsx",
              "ui/combobox/picker-visual.tsx",
              "ui/forms/form-utils/picker-field.tsx",
            ]}
          />
        ),
        content: <PickerSection />,
      },
      {
        id: "records",
        title: "Records: ledger and timeline",
        icon: ListBulletsIcon,
        description: (
          <ComponentsLine
            components={[
              "RecordsBlockView",
              "Ledger",
              "LedgerRow",
              "LedgerCell",
              "RecordList",
              "RecordRow",
              "RecordGroup",
              "RecordHeading",
              "RecordMore",
              "RecordFold",
              "RecordDot",
              "RecordScore",
              "RecordHops",
              "RecordDetail",
            ]}
            source={[
              "entity/entity-detail/records-block.tsx",
              "ui/common/ledger.tsx",
              "ui/common/record-list.tsx",
            ]}
          />
        ),
        content: <RecordsSection />,
      },
      {
        id: "rtable",
        title: "RTable",
        icon: TableIcon,
        overflowVisible: true,
        description: (
          <ComponentsLine
            components={[
              "RTable",
              "ListWorkbench",
              "BulkActionBar",
              "EditableCell",
              "CellFrame",
              "createNameColumn",
              "createCurrencyColumn",
              "createPlainDateColumn",
            ]}
            source={[
              "ui/data-table/table.tsx",
              "ui/data-table/list-workbench.tsx",
              "ui/data-table/column-helpers.tsx",
            ]}
          />
        ),
        content: <RTableSection />,
      },
      {
        id: "indexed-sections",
        title: "IndexedSections",
        icon: ListBulletsIcon,
        description: (
          <ComponentsLine
            components={["IndexedSections", "SectionStack"]}
            source={["ui/data-table/indexed-sections.tsx"]}
          />
        ),
        content: (
          <p className="text-xs text-muted-foreground">
            This page: grouped, continuously mounted sections with the sticky
            contents index from record details, the current entry tracked while
            scrolling, and a “Jump to” menu below 800px.
          </p>
        ),
      },
    ],
  },
  {
    id: "detail-group-household",
    title: "Household components",
    sections: [
      {
        id: "location-tree",
        title: "LocationTree",
        icon: TreeStructureIcon,
        description: (
          <ComponentsLine
            components={["LocationTree"]}
            source={["features/inventory/location-tree-view.tsx"]}
          />
        ),
        content: <LocationTreeSection />,
      },
      {
        id: "values",
        title: "Dates, pills and filters",
        icon: CalendarBlankIcon,
        overflowVisible: true,
        description: (
          <ComponentsLine
            components={[
              "DateDisplay",
              "EnumPill",
              "GapChipCluster",
              "FilterBar",
              "ScopeChip",
            ]}
            source={[
              "ui/common/date-display.tsx",
              "ui/primitives/enum-pill.tsx",
              "entity/work-queue/work-queue-display.tsx",
              "ui/data-table/filter-bar.tsx",
            ]}
          />
        ),
        content: <ValuesSection />,
      },
      {
        id: "recipe-units",
        title: "Recipe text and unit conversion",
        icon: CookingPotIcon,
        description: (
          <ComponentsLine
            components={["formatRichText", "ConversionCapabilities"]}
            source={[
              "features/recipe/richtext.tsx",
              "features/units/conversion-capabilities.tsx",
            ]}
          />
        ),
        content: <RecipeUnitsSection />,
      },
    ],
  },
  {
    id: "detail-group-basics",
    title: "Basics",
    sections: [
      {
        id: "foundations",
        title: "Foundations",
        icon: PaletteIcon,
        description: (
          <ComponentsLine
            components={["Page", "Card", "Badge"]}
            source={["styles.css", "ui/layout/page.tsx"]}
          />
        ),
        content: <FoundationsSection />,
      },
      {
        id: "controls",
        title: "Controls",
        icon: SlidersHorizontalIcon,
        overflowVisible: true,
        description: (
          <ComponentsLine
            components={[
              "Button",
              "Input",
              "Checkbox",
              "FormFieldGroup",
              "DropdownMenu",
              "Table",
            ]}
            source={["ui/primitives/", "ui/forms/form-field-group.tsx"]}
          />
        ),
        content: <ControlsSection />,
      },
      {
        id: "feedback",
        title: "Feedback, dialogs and tabs",
        icon: ChatCircleTextIcon,
        description: (
          <ComponentsLine
            components={[
              "Alert",
              "Skeleton",
              "Empty",
              "ResponsiveDialog",
              "Tabs",
            ]}
            source={["ui/primitives/"]}
          />
        ),
        content: <FeedbackSection />,
      },
    ],
  },
];

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
      <IndexedSections groups={GROUPS} />
    </Page>
  );
}
