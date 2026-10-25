import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { actionItems } from "~/entity/actions/action-items";
import { cn } from "~/lib/utils";
import { focusOnMount } from "~/ui/hooks/focus-on-mount";
import { Overlay } from "~/ui/overlays/overlay";
import { Input } from "~/ui/primitives/input";

import { domainChipClass } from "../../ui/navigation/domain-wayfinding";
import { NavigationCountBadge } from "../../ui/navigation/navigation-count-badge";
import {
  sidebarSections,
  settingsNavItem,
  type NavItem,
  navIconClass,
  navActiveClass,
} from "./nav-items";

type SearchItem = { item: NavItem; section: string; keywords: string[] };
const searchableItems: SearchItem[] = sidebarSections.flatMap((section) =>
  section.children.map((item) => ({
    item,
    section: section.label,
    keywords: actionItems
      .filter((action) => action.path === item.to)
      .flatMap((action) => action.keywords ?? []),
  })),
);
export function filterWorkspaceDestinations(query: string): SearchItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return needle
    ? searchableItems.filter(({ item, section, keywords }) =>
        `${item.label} ${section} ${keywords.join(" ")}`
          .toLocaleLowerCase()
          .includes(needle),
      )
    : [];
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
      onClick={onNavigate}
      className={cn(
        "flex h-9 items-center gap-2 rounded-lg px-2 text-sm transition-colors hover:bg-muted hover:text-foreground-strong",
        !active && "text-muted-foreground",
        active && ["font-medium text-foreground-strong", navActiveClass(item)],
      )}
      aria-current={active ? "page" : undefined}
    >
      <Icon
        className={cn("size-3.5 shrink-0", navIconClass(item))}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {item.entity && <NavigationCountBadge entity={item.entity} />}
      {section && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {section}
        </span>
      )}
    </Link>
  );
}
export function WorkspaceNavigator({
  open,
  onOpenChange,
  activeTo,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTo: string | undefined;
}) {
  const [query, setQuery] = useState("");
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
    if (open) setQuery("");
  }, [open]);
  const results = useMemo(() => filterWorkspaceDestinations(query), [query]);
  const close = () => onOpenChange(false);
  return (
    <Overlay
      placement="panel"
      open={open}
      onOpenChange={onOpenChange}
      title="More"
      bodyMode="form"
    >
      <div className="relative shrink-0 border-b border-border p-3">
        <MagnifyingGlassIcon className="absolute top-1/2 left-6 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={focusOnMount}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a destination…"
          aria-label="Find a workspace destination"
          className="pl-8"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
        {query.trim() ? (
          <section aria-label="Destination search results">
            {results.length ? (
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
        ) : (
          sidebarSections.map((section) => (
            <section
              key={section.id}
              aria-label={section.label || "Home and activity"}
              className="mt-2.5"
            >
              {section.label && (
                <h3 className="flex h-6 items-center gap-1 px-2 text-xs font-medium text-muted-foreground">
                  {section.domain && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 shrink-0 rounded-[2px]",
                        domainChipClass(section.domain),
                      )}
                    />
                  )}
                  {section.label}
                </h3>
              )}
              {section.children.map((item) => (
                <NavigatorLink
                  key={item.to}
                  item={item}
                  activeTo={activeTo}
                  onNavigate={close}
                />
              ))}
            </section>
          ))
        )}
        <div className="mt-3 border-t border-border pt-1">
          <NavigatorLink
            item={settingsNavItem}
            activeTo={activeTo}
            onNavigate={close}
          />
        </div>
      </div>
    </Overlay>
  );
}
