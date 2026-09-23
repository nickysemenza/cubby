import { Link } from "@tanstack/react-router";
import { ChevronLeft, Search, Wrench } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { actionItems } from "~/app/_components/actions/action-items";
import { AuthenticatedShellAccount } from "~/app/_components/navigation/authenticated-shell-controls";
import { Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ResponsiveSheet } from "~/components/ui/responsive-sheet";
import { focusOnMount } from "~/hooks/focus-on-mount";
import { cn } from "~/lib/utils";

import { domainWayfinding } from "./domain-wayfinding";
import {
  completeNavLeaves,
  desktopNav,
  homeNavItem,
  isNavGroup,
  mobileHouseholdItems,
  type NavGroup,
  type NavItem,
  primaryNavGroups,
  settingsNavItem,
  workspaceUtilitySections,
} from "./nav-items";
import { NavigationCountBadge } from "./navigation-count-badge";

export type WorkspaceNavigatorView = "household" | "utility";

type SearchItem = { item: NavItem; section: string; keywords: string[] };

function searchItem(item: NavItem, section: string): SearchItem {
  return {
    item,
    section,
    keywords: actionItems
      .filter((action) => action.path === item.to)
      .flatMap((action) => action.keywords ?? []),
  };
}

const searchableItems: SearchItem[] = [
  searchItem(homeNavItem, "Household"),
  ...desktopNav.flatMap((node) =>
    isNavGroup(node)
      ? node.children.map((item) => searchItem(item, node.label))
      : [searchItem(node, "Household")],
  ),
].filter(
  ({ item }, index, all) =>
    all.findIndex((candidate) => candidate.item.to === item.to) === index,
);

export function filterWorkspaceDestinations(query: string): SearchItem[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  return searchableItems.filter(({ item, section, keywords }) =>
    `${item.label} ${section} ${keywords.join(" ")}`
      .toLocaleLowerCase()
      .includes(needle),
  );
}

function NavigatorLink({
  item,
  activeTo,
  section,
  onNavigate,
}: {
  item: NavItem;
  activeTo: string | undefined;
  section?: string;
  onNavigate: () => void;
}) {
  const active = item.to === activeTo;
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      // SAFETY: nav-item search values are generated for their own literal
      // routes; the heterogeneous navigation catalog loses that correlation.
      search={item.search as never}
      onClick={onNavigate}
      className={cn(
        "flex min-h-11 items-center gap-2 border border-transparent px-2 py-2 text-sm transition-colors hover:bg-muted hover:text-primary",
        !active && "text-muted-foreground",
        active && "border-border bg-muted font-medium text-foreground",
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{item.label}</span>
      {item.entity && <NavigationCountBadge entity={item.entity} />}
      {section && (
        <span className="shrink-0 font-mono text-2xs text-slate uppercase">
          {section}
        </span>
      )}
    </Link>
  );
}

function GroupDisclosure({
  group,
  activeTo,
  onNavigate,
}: {
  group: NavGroup;
  activeTo: string | undefined;
  onNavigate: () => void;
}) {
  const Icon = group.icon;
  const domain = group.domain ? domainWayfinding(group.domain) : null;
  return (
    <details
      className="border-b border-l border-border"
      style={
        domain ? { borderLeftColor: `var(${domain.accentToken})` } : undefined
      }
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-2 py-2 text-sm font-medium hover:bg-muted [&::-webkit-details-marker]:hidden">
        <span
          style={domain ? { color: `var(${domain.accentToken})` } : undefined}
          aria-hidden="true"
        >
          <Icon className="size-3.5" />
        </span>
        {group.label}
      </summary>
      <div className="border-t border-border bg-background p-1">
        {group.children.map((item) => (
          <NavigatorLink
            key={item.to}
            item={item}
            activeTo={activeTo}
            onNavigate={onNavigate}
          />
        ))}
      </div>
    </details>
  );
}

export function WorkspaceNavigator({
  open,
  onOpenChange,
  initialView,
  activeTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialView: WorkspaceNavigatorView;
  activeTo: string | undefined;
}) {
  const [view, setView] = useState<WorkspaceNavigatorView>(initialView);
  const [query, setQuery] = useState("");
  const householdHeadingId = useId();
  const workspaceHeadingId = useId();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      returnFocusRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    } else if (!open && wasOpenRef.current) {
      requestAnimationFrame(() => returnFocusRef.current?.focus());
    }
    wasOpenRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setView(initialView);
    setQuery("");
  }, [initialView, open]);

  const results = useMemo(() => {
    return filterWorkspaceDestinations(query);
  }, [query]);

  const close = () => onOpenChange(false);
  const searching = query.trim().length > 0;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={view === "household" ? "More" : "Tools & data"}
      description={
        view === "household"
          ? "Household destinations and the complete workspace."
          : "Reference data, utilities, and developer tools."
      }
    >
      <Stack gap="md">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={focusOnMount}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a destination…"
            aria-label="Find a workspace destination"
            className="pl-8"
          />
        </div>

        {searching ? (
          <section aria-label="Destination search results">
            {results.length > 0 ? (
              results.map(({ item, section }) => (
                <NavigatorLink
                  key={item.to}
                  item={item}
                  section={section}
                  activeTo={activeTo}
                  onNavigate={close}
                />
              ))
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No destination matched “{query.trim()}”.
              </p>
            )}
          </section>
        ) : view === "household" ? (
          <>
            <section
              aria-label="Account"
              className="flex min-h-12 items-center gap-2 border-y border-border px-2 py-1"
            >
              <AuthenticatedShellAccount />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Household account</p>
                <p className="truncate text-xs text-muted-foreground">
                  Identity and application preferences
                </p>
              </div>
              <NavigatorLink
                item={settingsNavItem}
                activeTo={activeTo}
                onNavigate={close}
              />
            </section>
            <section aria-labelledby={householdHeadingId}>
              <h3 id={householdHeadingId} className="px-2 pb-1 eyebrow">
                Household
              </h3>
              {mobileHouseholdItems.map((item) => (
                <NavigatorLink
                  key={item.to}
                  item={item}
                  activeTo={activeTo}
                  onNavigate={close}
                />
              ))}
            </section>
            <section aria-labelledby={workspaceHeadingId}>
              <h3 id={workspaceHeadingId} className="px-2 pb-1 eyebrow">
                Workspace
              </h3>
              {primaryNavGroups.map((group) => (
                <GroupDisclosure
                  key={group.label}
                  group={group}
                  activeTo={activeTo}
                  onNavigate={close}
                />
              ))}
            </section>
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start"
              onClick={() => setView("utility")}
            >
              <Wrench />
              Tools & data
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              className="w-fit"
              onClick={() => setView("household")}
            >
              <ChevronLeft />
              Back to household
            </Button>
            {workspaceUtilitySections.map((section) => (
              <section key={section.title} aria-label={section.title}>
                <h3 className="px-2 pb-1 eyebrow">{section.title}</h3>
                {section.items.map((item) => (
                  <NavigatorLink
                    key={item.to}
                    item={item}
                    activeTo={activeTo}
                    onNavigate={close}
                  />
                ))}
              </section>
            ))}
          </>
        )}
      </Stack>
    </ResponsiveSheet>
  );
}

export const workspaceNavigatorLeavesForTest = completeNavLeaves;
