import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { z } from "zod";

import { preloadCommandMenu } from "~/features/command-menu/command-menu-loader";
import type { UnparsedError } from "~/lib/error-utils";
import { cn } from "~/lib/utils";
import { useHydrated } from "~/ui/hooks/useHydrated";
import { useLocalStorage } from "~/ui/hooks/useLocalStorage";
import {
  useAppViewportBounds,
  useVirtualKeyboard,
} from "~/ui/hooks/useVirtualKeyboard";
import { MainNav } from "~/ui/MainNav";
import { Button } from "~/ui/primitives/button";

import {
  AuthenticatedShellAccount,
  AuthenticatedShellControls,
} from "./authenticated-shell-controls";
import { domainWayfinding } from "./domain-wayfinding";
import { createInAppHistory } from "./in-app-history";
import { resolveMobileRoute } from "./mobile-route-descriptor";
import {
  homeNavItem,
  type NavGroup,
  type NavItem,
  navItemLinkProps,
  primaryNavGroups,
  settingsNavItem,
  useActiveTo,
} from "./nav-items";
import { NavigationCountBadge } from "./navigation-count-badge";
import {
  SidebarRailGroup as RailGroupFlyout,
  SidebarRailLeaf as RailLeaf,
} from "./sidebar-rail-group";
import { WorkspaceNavigator } from "./workspace-navigator";

const LOGO_SRC = import.meta.env.DEV ? "/favicon-dev.svg" : "/favicon.svg";
const collapsedPreferenceSchema = z.boolean();
const foldedGroupsSchema = z.array(z.string());
let lastCatchUpRequestAt = 0;
let catchUpRequestPending = false;

function requestCatchUpWhenVisible() {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  if (catchUpRequestPending || now - lastCatchUpRequestAt < 5 * 60_000) return;
  catchUpRequestPending = true;
  void import("~/integrations/tanstack-query/generated/catalog.gen")
    .then(({ maintenance }) => maintenance.requestCatchUp.call())
    .then(() => {
      lastCatchUpRequestAt = Date.now();
    })
    .catch((error: UnparsedError) =>
      console.error("App-open catch-up request failed", error),
    )
    .finally(() => {
      catchUpRequestPending = false;
    });
}

const ShellControls = AuthenticatedShellControls;
const ShellAccount = AuthenticatedShellAccount;

type AuthenticatedAppShellProps = {
  children: ReactNode;
  footer: ReactNode;
  mainContentId: string;
  navigationProgress: ReactNode;
  onSearchClick: () => void;
};

/**
 * The authenticated workspace frame. The md rail is intentionally forced: a
 * person's wide/compact preference applies only when there is space for the
 * full 176px sidebar, and a tablet visit must never overwrite that preference.
 */
export function AuthenticatedAppShell({
  children,
  footer,
  mainContentId,
  navigationProgress,
  onSearchClick,
}: AuthenticatedAppShellProps) {
  useAppViewportBounds();
  const [collapsed, setCollapsed] = useLocalStorage(
    "app-shell:sidebar-collapsed",
    collapsedPreferenceSchema,
    false,
  );
  const expanded = !collapsed;
  const pathname = useLocation().pathname;
  const routeDescriptor = resolveMobileRoute(pathname);
  const viewportSurface = routeDescriptor.presentation === "immersive";
  const keyboardOpen = useVirtualKeyboard();
  const hydrated = useHydrated();

  useEffect(() => {
    requestCatchUpWhenVisible();
    document.addEventListener("visibilitychange", requestCatchUpWhenVisible);
    return () =>
      document.removeEventListener(
        "visibilitychange",
        requestCatchUpWhenVisible,
      );
  }, []);

  return (
    <div
      data-app-shell="authenticated"
      data-hydrated={hydrated ? "true" : "false"}
      data-mobile-keyboard={keyboardOpen ? "open" : "closed"}
      className={cn(
        "min-h-dvh bg-background [--app-chrome-bottom:calc(3.5rem+1px+env(safe-area-inset-bottom))] [--app-chrome-top:calc(3rem+1px+env(safe-area-inset-top))] md:flex md:[--app-chrome-bottom:0rem] md:[--app-chrome-top:var(--app-command-band-height)]",
        keyboardOpen && "[--app-chrome-bottom:0rem]",
      )}
    >
      <WorkspaceSidebar
        expanded={expanded}
        onToggle={() => setCollapsed((value) => !value)}
      />
      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
        {/* Today owns the Cubby mark. Working routes use semantic local chrome
            so a deep link still says where it is and where Back will go. */}
        <div className="safe-top sticky top-0 z-40 border-b border-border bg-card md:hidden print:hidden">
          <MobileRouteBar pathname={pathname} onSearchClick={onSearchClick} />
          {navigationProgress}
        </div>
        <DesktopCommandHeader
          onSearchClick={onSearchClick}
          navigationProgress={navigationProgress}
        />
        {/* Flush to the rail and the command header: the table's own border
            is the page edge, so main spends no gutter. Phone clearance tracks
            the actual fixed bar, including the home-indicator inset, so the
            last row can never land underneath the navigation. */}
        <main
          id={mainContentId}
          tabIndex={-1}
          className={cn(
            "min-w-0 flex-1",
            viewportSurface
              ? "overflow-hidden"
              : "pb-[calc(var(--app-chrome-bottom)+1rem)] md:pb-0",
          )}
        >
          {children}
        </main>
        {!viewportSurface && <div className="hidden md:block">{footer}</div>}
      </div>
    </div>
  );
}

function MobileRouteBar({
  pathname,
  onSearchClick,
}: {
  pathname: string;
  onSearchClick: () => void;
}) {
  const router = useRouter();
  const history = useMemo(() => createInAppHistory(router.history), [router]);
  const canGoBack = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    () => false,
  );
  const descriptor = resolveMobileRoute(pathname);
  if (descriptor.tab === "today") {
    return (
      <div className="flex h-12 w-full items-center px-2">
        <MainNav onSearchClick={onSearchClick} />
      </div>
    );
  }

  return (
    <div className="grid h-12 w-full grid-cols-[2.75rem_minmax(0,1fr)_auto] items-center px-1">
      <Button
        aria-label="Back"
        onClick={() => {
          if (canGoBack) router.history.back();
          else void router.navigate({ to: descriptor.parentTo ?? "/" });
        }}
        variant="ghost"
        size="icon"
        className="size-11"
      >
        <CaretLeftIcon className="size-5" />
      </Button>
      <p className="truncate font-heading text-sm font-semibold tracking-tight">
        {descriptor.label}
      </p>
      <Suspense fallback={<div className="h-8 w-20" aria-hidden="true" />}>
        <ShellControls />
      </Suspense>
    </div>
  );
}

function DesktopCommandHeader({
  onSearchClick,
  navigationProgress,
}: Pick<AuthenticatedAppShellProps, "onSearchClick" | "navigationProgress">) {
  return (
    <header className="sticky top-0 z-40 hidden h-(--app-command-band-height) items-center border-b border-border bg-card px-4 md:flex md:px-6 print:hidden">
      <p className="text-xs font-medium text-muted-foreground">Cubby</p>
      <Button
        variant="ghost"
        size="sm"
        onClick={onSearchClick}
        onPointerEnter={preloadCommandMenu}
        onFocus={preloadCommandMenu}
        onTouchStart={preloadCommandMenu}
        className="ml-auto h-7 px-2 lg:hidden"
        aria-label="Search"
        title="Search"
      >
        <MagnifyingGlassIcon className="size-3.5" />
        <span className="sr-only">Search Cubby</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onSearchClick}
        onPointerEnter={preloadCommandMenu}
        onFocus={preloadCommandMenu}
        onTouchStart={preloadCommandMenu}
        className="ml-auto hidden h-7 min-w-52 justify-start px-2 text-muted-foreground lg:flex"
        aria-label="Search"
      >
        <MagnifyingGlassIcon className="size-3.5" />
        Search Cubby
        <span className="ml-auto font-mono text-2xs">⌘K</span>
      </Button>
      <Suspense fallback={<div className="ml-2 h-8 w-28" aria-hidden="true" />}>
        <ShellControls />
      </Suspense>
      {navigationProgress}
    </header>
  );
}

function WorkspaceSidebar({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  const activeTo = useActiveTo();
  const [utilityOpen, setUtilityOpen] = useState(false);
  const [utilityMounted, setUtilityMounted] = useState(false);
  const [foldedGroups, setFoldedGroups] = useLocalStorage(
    "app-shell:sidebar-folded-groups",
    foldedGroupsSchema,
    [],
  );

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 border-r border-border bg-card md:flex md:w-[var(--app-sidebar-collapsed-width)] md:flex-col lg:transition-[width] lg:duration-150 print:hidden",
        expanded
          ? "lg:w-[var(--app-sidebar-expanded-width)]"
          : "lg:w-[var(--app-sidebar-collapsed-width)]",
      )}
      aria-label="Workspace navigation"
      data-app-rail
    >
      <div className="flex h-(--app-command-band-height) shrink-0 items-center border-b border-border px-2.5">
        <Link
          to="/"
          aria-label="Cubby home"
          className="flex min-w-0 items-center gap-2"
        >
          <img src={LOGO_SRC} alt="" className="size-5 shrink-0" />
          {expanded && (
            <span className="hidden truncate font-heading text-base font-semibold tracking-tight lg:block">
              cubby
            </span>
          )}
        </Link>
      </div>
      <nav
        // `relative`: the nav's sr-only counts are absolutely positioned; without
        // a positioned scroller they escape its clip and stretch the document
        // past the shell, so scrolling a button into view drags the shell up.
        className="relative min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5"
        aria-label="Cubby"
      >
        <SidebarHome active={activeTo === homeNavItem.to} expanded={expanded} />
        {primaryNavGroups.map((group) => (
          <SidebarGroup
            key={group.label}
            group={group}
            expanded={expanded}
            activeTo={activeTo}
            folded={foldedGroups.includes(group.label)}
            onToggleFolded={() =>
              setFoldedGroups((labels) =>
                labels.includes(group.label)
                  ? labels.filter((label) => label !== group.label)
                  : [...labels, group.label],
              )
            }
          />
        ))}
      </nav>
      <div
        className={cn(
          "flex flex-col items-center gap-0.5 border-t border-border p-1.5",
          expanded && "lg:min-h-10 lg:flex-row lg:py-0",
        )}
      >
        <Suspense fallback={<div className="size-7" aria-hidden="true" />}>
          <ShellAccount />
        </Suspense>
        <span
          className={cn("hidden", expanded && "lg:block lg:flex-1")}
          aria-hidden="true"
        />
        <Suspense fallback={<SidebarRailLeafFallback item={settingsNavItem} />}>
          <RailLeaf
            item={settingsNavItem}
            active={activeTo === settingsNavItem.to}
          />
        </Suspense>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => {
            setUtilityMounted(true);
            setUtilityOpen(true);
          }}
          className="size-7 text-muted-foreground"
          aria-label="Tools & data"
          title="Tools & data"
        >
          <WrenchIcon className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onToggle}
          className="hidden size-7 text-muted-foreground lg:flex"
          aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
          title={expanded ? "Collapse sidebar" : "Expand sidebar"}
        >
          {expanded ? (
            <SidebarSimpleIcon className="size-3.5" />
          ) : (
            <CaretRightIcon className="size-3.5" />
          )}
        </Button>
      </div>
      {utilityMounted && (
        <Suspense fallback={null}>
          <WorkspaceNavigator
            open={utilityOpen}
            onOpenChange={setUtilityOpen}
            initialView="utility"
            activeTo={activeTo}
          />
        </Suspense>
      )}
    </aside>
  );
}

function SidebarHome({
  active,
  expanded,
}: {
  active: boolean;
  expanded: boolean;
}) {
  return (
    <>
      <div className={cn("md:block", expanded && "lg:hidden")}>
        <Suspense fallback={<SidebarRailLeafFallback item={homeNavItem} />}>
          <RailLeaf item={homeNavItem} active={active} />
        </Suspense>
      </div>
      {expanded && (
        <div className="hidden lg:block">
          <SidebarFullLeaf item={homeNavItem} active={active} />
        </div>
      )}
    </>
  );
}

function SidebarGroup({
  group,
  expanded,
  activeTo,
  folded,
  onToggleFolded,
}: {
  group: NavGroup;
  expanded: boolean;
  activeTo: string | undefined;
  folded: boolean;
  onToggleFolded: () => void;
}) {
  return (
    <>
      <div className={cn("md:block", expanded && "lg:hidden")}>
        <Suspense fallback={<SidebarRailGroupFallback group={group} />}>
          <RailGroupFlyout group={group} activeTo={activeTo} />
        </Suspense>
      </div>
      {expanded && (
        <div className="hidden lg:block">
          <SidebarExpandedDomainGroup
            group={group}
            activeTo={activeTo}
            folded={folded}
            onToggleFolded={onToggleFolded}
          />
        </div>
      )}
    </>
  );
}

/**
 * The expanded rail is a direct route index whose sections fold; collapsed
 * mode keeps the flyout. The domain dot carries the domain mark.
 */
function SidebarExpandedDomainGroup({
  group,
  activeTo,
  folded,
  onToggleFolded,
}: {
  group: NavGroup;
  activeTo: string | undefined;
  folded: boolean;
  onToggleFolded: () => void;
}) {
  const domain = group.domain ? domainWayfinding(group.domain) : null;
  const routesId = useId();

  return (
    <section className="mt-3" aria-label={group.label}>
      <button
        type="button"
        onClick={onToggleFolded}
        aria-expanded={!folded}
        aria-controls={routesId}
        className="flex h-6 w-full items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span
          className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
          style={
            domain
              ? { backgroundColor: `var(${domain.accentToken})` }
              : undefined
          }
          aria-hidden="true"
        />
        {group.label}
        <CaretDownIcon
          className={cn(
            "size-2.5 transition-transform",
            folded && "-rotate-90",
          )}
          aria-hidden="true"
        />
      </button>
      {/* A folded section still shows its current route, so the rail never
          loses the you-are-here cue. */}
      <div id={routesId}>
        {group.children
          .filter((item) => !folded || item.to === activeTo)
          .map((item) => (
            <SidebarFullLeaf
              key={item.to}
              item={item}
              active={activeTo === item.to}
            />
          ))}
      </div>
    </section>
  );
}

function SidebarRailGroupFallback({ group }: { group: NavGroup }) {
  const Icon = group.icon;
  return (
    <button
      type="button"
      className="mb-0.5 flex size-7 items-center justify-center text-muted-foreground"
      aria-label={group.label}
      title={group.label}
      disabled
    >
      <Icon className="size-3.5" />
    </button>
  );
}

function SidebarFullLeaf({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      {...navItemLinkProps(item, active)}
      className={cn(
        "flex h-6.5 min-w-0 items-center gap-2 rounded-md px-2 text-[0.8125rem] transition-colors hover:bg-muted/60 hover:text-foreground",
        !active && "text-foreground/80",
        active && "bg-muted font-medium text-foreground hover:bg-muted",
      )}
    >
      <Icon
        className={cn("size-3.5 shrink-0", !active && "text-muted-foreground")}
        weight={active ? "bold" : "regular"}
      />
      <span className="min-w-0 truncate">{item.label}</span>
      {item.entity && <NavigationCountBadge entity={item.entity} />}
    </Link>
  );
}

function SidebarRailLeafFallback({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      className="mb-0.5 flex size-7 items-center justify-center text-muted-foreground"
      aria-label={item.label}
      title={item.label}
      disabled
    >
      <Icon className="size-3.5" />
    </button>
  );
}
