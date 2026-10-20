import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import type { ReactNode } from "react";

import { AddFactValue, type Fact, Facts } from "~/ui/common/facts";
import { type KeyNumber, KeyNumbers } from "~/ui/common/key-numbers";
import { EmptyState } from "~/ui/feedback/empty-state";
import { Disclosure, Panel, Section, Stack, Toolbar } from "~/ui/layout";
import { PageHeader } from "~/ui/layout/page-header";
import { Badge } from "~/ui/primitives/badge";
import { Button } from "~/ui/primitives/button";
import { Input } from "~/ui/primitives/input";
import { Kbd } from "~/ui/primitives/kbd";

/** A labelled specimen; `data-specimen` is the pixel-comparison anchor. */
function Specimen({
  id,
  name,
  children,
}: {
  id: string;
  name: string;
  children: ReactNode;
}) {
  return (
    <figure className="min-w-0 space-y-2">
      <figcaption className="font-mono text-2xs text-muted-foreground">
        {name}
      </figcaption>
      <div data-specimen={id} className="min-w-0">
        {children}
      </div>
    </figure>
  );
}

const noop = () => undefined;

export function PageHeaderSection() {
  return (
    <Stack gap="lg">
      <Specimen id="page-header-detail" name='layout="stacked" · detail'>
        <PageHeader
          layout="stacked"
          breadcrumb={
            <span>
              Finance / Vendors / <span className="font-mono">VEN-7QK2</span>
            </span>
          }
          title="Northside Hardware"
          status={<Badge variant="positive">Active</Badge>}
          actions={
            <>
              <Button variant="outline">Edit</Button>
              <Button>New purchase</Button>
            </>
          }
          facts={[
            <span key="last">
              Last purchase <strong>Oct 12</strong>
            </span>,
            <span key="count">
              <strong>38</strong> purchases
            </span>,
            <span key="added">added Mar 2024</span>,
          ]}
        />
      </Specimen>
      <Specimen
        id="page-header-list"
        name='layout="inline" · list and tool pages'
      >
        <PageHeader
          layout="inline"
          title="Purchases"
          facts={[
            <span key="year">
              <strong>412</strong> this year
            </span>,
            <strong key="total" className="money">
              $18,240.55
            </strong>,
          ]}
          actions={
            <>
              <Button variant="outline">Import</Button>
              <Button>New purchase</Button>
            </>
          }
        />
      </Specimen>
      <Specimen id="page-header-home" name='layout="stacked" · Home'>
        <PageHeader
          layout="stacked"
          title="Tuesday, October 20"
          description="3 things need you · 2 deliveries due this week"
        />
      </Specimen>
    </Stack>
  );
}

const KEY_NUMBERS: KeyNumber[] = [
  {
    label: "Spend this year",
    value: "$2,481.20",
    money: true,
    context: "+12% vs last year",
  },
  { label: "Purchases", value: "38", context: "4 this month" },
  { label: "Avg order", value: "$65.29", money: true },
  { label: "Last order", value: "Oct 12", context: "8 days ago" },
];

const INLINE_NUMBERS: KeyNumber[] = [
  { label: "this year", value: "$2,481.20", money: true },
  { label: "purchases", value: "38" },
  { label: "avg", value: "$65.29", money: true },
  { label: "last order", value: "Oct 12" },
];

export function KeyNumbersSection() {
  return (
    <Stack gap="lg">
      <Specimen id="key-numbers-strip" name='layout="strip"'>
        <KeyNumbers layout="strip" label="Vendor figures" items={KEY_NUMBERS} />
      </Specimen>
      <Specimen id="key-numbers-inline" name='layout="inline"'>
        <KeyNumbers
          layout="inline"
          label="Vendor figures"
          items={INLINE_NUMBERS}
        />
      </Specimen>
      <Specimen id="key-numbers-drill" name="onSelect · active">
        <KeyNumbers
          layout="strip"
          label="Statement rows"
          items={[
            { label: "Total", value: "412", onSelect: noop, active: true },
            { label: "Matched", value: "398", onSelect: noop },
            { label: "Unmatched", value: "9", onSelect: noop, tone: "warning" },
            { label: "Ignored", value: "5", onSelect: noop },
          ]}
        />
      </Specimen>
    </Stack>
  );
}

export function SectionSection() {
  return (
    <Stack gap="lg">
      <Specimen id="section-count" name="title · count · actions">
        <Section
          headingAs="h3"
          title="Purchases"
          count={38}
          actions={
            <Button variant="ghost" size="icon-xs" aria-label="Add purchase">
              <PlusIcon className="size-4" />
            </Button>
          }
        >
          <p className="text-muted-foreground">…rows</p>
        </Section>
      </Specimen>
      <Specimen id="section-caption" name="caption">
        <Section
          headingAs="h3"
          title="Spending"
          caption="Groceries are 41% of this month, up from 33%."
        >
          <p className="text-muted-foreground">…chart</p>
        </Section>
      </Specimen>
      <Specimen id="section-compact" name="compact · disclosure · empty">
        <Stack gap="md">
          <Section
            headingAs="h3"
            compact
            title="Matching evidence"
            count={3}
            disclosure={{ defaultOpen: true }}
          >
            <p className="text-muted-foreground">
              Order email, card charge and receipt photo.
            </p>
          </Section>
          <Section headingAs="h3" compact empty title="Attachments" count={0}>
            <EmptyState size="inline">No attachments yet.</EmptyState>
          </Section>
        </Stack>
      </Specimen>
    </Stack>
  );
}

export function PanelSection() {
  return (
    <Stack gap="lg">
      <Specimen id="panel-tones" name='tone="default" · "muted" · "warning"'>
        <div className="grid gap-2 sm:grid-cols-3">
          <Panel
            tone="default"
            headingAs="h3"
            title="Sign in"
            caption="Default: hairline"
          />
          <Panel
            tone="muted"
            headingAs="h3"
            title="Connection details"
            caption="Muted: fill, no border"
          />
          <Panel
            tone="warning"
            headingAs="h3"
            title="Bank feed paused"
            caption="Warning: tinted fill"
          />
        </div>
      </Specimen>
      <Specimen id="panel-actions" name="title · actions · body">
        <Panel
          tone="default"
          headingAs="h3"
          title="Dependencies for Pantry shelving"
          actions={
            <Button variant="ghost" size="sm">
              Close
            </Button>
          }
        >
          <p className="text-muted-foreground">
            Blocked by Measure alcove · Blocking Stock pantry
          </p>
        </Panel>
      </Specimen>
    </Stack>
  );
}

export function EmptyStateSection() {
  return (
    <Stack gap="lg">
      <Specimen id="empty-inline" name='size="inline"'>
        <EmptyState size="inline">
          No purchases yet. <a href="#empty-state">Add one</a> or import an
          order email.
        </EmptyState>
      </Specimen>
      <Specimen id="empty-page" name='size="page"'>
        <EmptyState
          size="page"
          icon={MagnifyingGlassIcon}
          action={<Button variant="outline">Clear search</Button>}
        >
          No products match “oat milk”
        </EmptyState>
      </Specimen>
    </Stack>
  );
}

const FILTER_CHIPS = ["Status is Active", "Vendor is 2", "Cost ≥ $20"];

export function ToolbarSection() {
  return (
    <Specimen id="toolbar" name="start · end · below">
      <Toolbar
        label="Purchase list controls"
        start={
          <>
            <Button variant="outline">
              Filter
              <span className="font-mono text-xs font-normal text-muted-foreground">
                · 3
              </span>
            </Button>
            <Button variant="outline">Sort</Button>
            <Button variant="outline">View</Button>
          </>
        }
        end={
          <div className="relative w-45">
            <Input
              aria-label="Search purchases"
              placeholder="Search…"
              aria-keyshortcuts="/"
              className="pr-7"
            />
            <Kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
              /
            </Kbd>
          </div>
        }
        below={
          <div className="flex flex-wrap items-center gap-1.5">
            {FILTER_CHIPS.map((chip) => (
              <Badge key={chip} variant="secondary" className="gap-1">
                {chip}
                <XIcon aria-hidden />
              </Badge>
            ))}
            <Button variant="link" size="xs" className="h-auto px-0 text-link">
              Clear
            </Button>
          </div>
        }
      />
    </Specimen>
  );
}

export function DisclosureSection() {
  return (
    <Specimen id="disclosure" name="summary · meta · aside">
      <Stack gap="sm">
        <Disclosure
          summary="Why this match"
          meta="3 signals"
          aside={
            <a href="#disclosure" className="text-xs text-link hover:underline">
              Open evidence
            </a>
          }
          defaultOpen
        >
          <p className="text-muted-foreground">
            Same merchant, amount within $0.40 and a receipt photo from the same
            day.
          </p>
        </Disclosure>
        <Disclosure summary="Technical details">
          <p className="font-mono text-xs">SQLSTATE 23505 · purchases_pkey</p>
        </Disclosure>
      </Stack>
    </Specimen>
  );
}

const DETAIL_FACTS: Fact[] = [
  { label: "Vendor", value: "Northside Hardware" },
  { label: "Category", value: "Hardware" },
  {
    label: "Total",
    value: <span className="money">$126.28</span>,
    explanation: "Sum of the order's line items after the store credit.",
  },
  { label: "Ordered", value: "Oct 12, 2026", caption: "from the order email" },
  { label: "Notes", value: undefined },
];

export function FactsSection() {
  return (
    <Stack gap="lg">
      <Specimen id="facts-list" name='layout="list"'>
        <Facts
          layout="list"
          facts={DETAIL_FACTS.map((fact) =>
            fact.value === undefined
              ? {
                  ...fact,
                  value: <AddFactValue label={fact.label} onAdd={noop} />,
                }
              : fact,
          )}
        />
      </Specimen>
      <Specimen id="facts-inline" name='layout="inline"'>
        <Facts
          layout="inline"
          facts={[
            { label: "Ordered", value: "Oct 12" },
            { label: "Items", value: "4" },
            {
              label: "Total",
              value: <span className="money">$126.28</span>,
            },
          ]}
        />
      </Specimen>
    </Stack>
  );
}
