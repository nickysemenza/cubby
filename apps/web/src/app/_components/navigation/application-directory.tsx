import { ArrowUpRightIcon as ArrowUpRight } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { DatabaseIcon as Database } from "@phosphor-icons/react/dist/csr/Database";
import { FlowArrowIcon as Workflow } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Link } from "@tanstack/react-router";
import { useId } from "react";

import { Grid, Row, Stack } from "~/components/layout";
import { Page } from "~/components/page/Page";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import {
  activityViews,
  recordViews,
  type ApplicationDestination,
} from "./application-views";

export type ApplicationDirectoryMode = "activities" | "records";

/** Static application destinations, not household records or search results. */
export function ApplicationDirectory({
  mode,
  query,
  onQueryChange,
}: {
  mode: ApplicationDirectoryMode;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const filterId = useId();
  const normalized = query.trim().toLocaleLowerCase();
  const groups = activityViews
    .map((view) => ({
      ...view,
      destinations: (mode === "activities"
        ? view.destinations
        : recordViews.filter((record) => record.domain === view.key)
      ).filter((destination) =>
        `${view.label} ${destination.label} ${destination.description}`
          .toLocaleLowerCase()
          .includes(normalized),
      ),
    }))
    .filter((view) => view.destinations.length > 0);
  const count = groups.reduce(
    (sum, group) => sum + group.destinations.length,
    0,
  );

  return (
    <Page
      variant="list"
      title={mode === "activities" ? "Activities" : "Records"}
    >
      <Stack gap="md">
        <Row gap="sm" wrap className="border-b border-border pb-3">
          <Button
            variant={mode === "activities" ? "secondary" : "ghost"}
            nativeButton={false}
            render={
              <Link
                to="/activities"
                aria-current={mode === "activities" ? "page" : undefined}
              />
            }
          >
            <Workflow className="size-4" aria-hidden /> Activities
          </Button>
          <Button
            variant={mode === "records" ? "secondary" : "ghost"}
            nativeButton={false}
            render={
              <Link
                to="/records"
                aria-current={mode === "records" ? "page" : undefined}
              />
            }
          >
            <Database className="size-4" aria-hidden /> Records
          </Button>
        </Row>
        <p className="max-w-prose text-sm text-muted-foreground">
          {mode === "activities"
            ? "Choose what you want to do around the house."
            : "Browse the records behind your food, belongings, plans, and spending."}
        </p>
        <div className="max-w-lg">
          <label htmlFor={filterId} className="mb-2 block text-sm font-medium">
            {mode === "activities" ? "Find an activity" : "Find a record type"}
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              id={filterId}
              type="search"
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder={
                mode === "activities"
                  ? "Try shopping, recipes, or statements"
                  : "Try products, meals, or expenses"
              }
              className="pl-9"
            />
          </div>
        </div>
        <output className="sr-only">
          {count}{" "}
          {mode === "activities"
            ? count === 1
              ? "activity"
              : "activities"
            : count === 1
              ? "record type"
              : "record types"}{" "}
          found
        </output>
        {groups.length === 0 ? (
          <Stack gap="sm" className="py-6">
            <h2 className="text-base font-semibold">
              No matching{" "}
              {mode === "activities" ? "activities" : "record types"}
            </h2>
            <p className="text-sm text-muted-foreground">
              Try a different word or clear the filter to see all destinations.
            </p>
            <Button
              variant="outline"
              className="self-start"
              onClick={() => onQueryChange("")}
            >
              Clear filter
            </Button>
          </Stack>
        ) : (
          <Grid className="grid-cols-1 items-start lg:grid-cols-2" gap="lg">
            {groups.map((group) => (
              <section
                key={group.key}
                aria-labelledby={`${filterId}-${group.key}`}
              >
                <Row gap="sm" className="border-b border-border pb-3">
                  <group.icon
                    className="size-5"
                    style={{ color: `var(--domain-${group.key})` }}
                    aria-hidden
                  />
                  <h2
                    id={`${filterId}-${group.key}`}
                    className="text-base font-semibold"
                  >
                    {group.label}
                  </h2>
                </Row>
                <ul className="divide-y divide-border">
                  {group.destinations.map((destination) => (
                    <DirectoryLink
                      key={destination.to}
                      destination={destination}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </Grid>
        )}
      </Stack>
    </Page>
  );
}

function DirectoryLink({
  destination,
}: {
  destination: ApplicationDestination;
}) {
  const labelId = useId();
  const descriptionId = useId();
  return (
    <li>
      <Link
        to={destination.to}
        aria-labelledby={labelId}
        aria-describedby={descriptionId}
        preload="intent"
        className="group flex min-h-11 items-start gap-3 rounded-md px-2 py-3 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring active:bg-muted"
      >
        <destination.icon
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 flex-1">
          <span
            id={labelId}
            className="block text-sm font-medium break-words group-hover:text-primary"
          >
            {destination.label}
          </span>
          <span
            id={descriptionId}
            className="mt-1 block text-sm text-muted-foreground"
          >
            {destination.description}
          </span>
        </span>
        <ArrowUpRight
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
      </Link>
    </li>
  );
}
