import { Link, useLocation, useRouter } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Search, Wrench } from "lucide-react";
import {
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { z } from "zod";

import { preloadCommandMenu } from "~/app/_components/command-menu-loader";
import { MainNav } from "~/app/_components/MainNav";
import { Button } from "~/components/ui/button";
import { useHydrated } from "~/hooks/useHydrated";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import {
  useAppViewportBounds,
  useVirtualKeyboard,
} from "~/hooks/useVirtualKeyboard";
import type { UnparsedError } from "~/lib/error-utils";
import { cn } from "~/lib/utils";

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
  todayNavItems,
  useActiveTo,
} from "./nav-items";
import {
  SidebarRailGroup as RailGroupFlyout,
  SidebarRailLeaf as RailLeaf,
} from "./sidebar-rail-group";
import { WorkspaceNavigator } from "./workspace-navigator";

const LOGO_SRC = import.meta.env.DEV ? "/favicon-dev.svg" : "/favicon.svg";
const collapsedPreferenceSchema = z.boolean();
let lastCatchUpRequestAt = 0;
let catchUpRequestPending = false;

function requestCatchUpWhenVisible() {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  if (catchUpRequestPending || now - lastCatchUpRequestAt < 5 * 60_000) return;
  catchUpRequestPending = true;
  void import("~/lib/maintenance.functions")
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
 * full 208px sidebar, and a tablet visit must never overwrite that preference.
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
        "min-h-dvh bg-background [--app-chrome-bottom:calc(3.5rem+1px+env(safe-area-inset-bottom))] [--app-chrome-top:calc(3rem+1px+env(safe-area-inset-top))] md:flex md:[--app-chrome-bottom:0rem] md:[--app-chrome-top:3rem]",
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
        <ChevronLeft className="size-5" />
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
    <header className="sticky top-0 z-40 hidden h-12 items-center border-b border-border bg-card px-4 md:flex md:px-6 print:hidden">
      <p className="text-xs font-medium text-muted-foreground">Cubby</p>
      <Button
        variant="ghost"
        size="sm"
        onClick={onSearchClick}
        onPointerEnter={preloadCommandMenu}
        onFocus={preloadCommandMenu}
        onTouchStart={preloadCommandMenu}
        className="ml-auto h-8 px-2 lg:hidden"
        aria-label="Search"
        title="Search"
      >
        <Search className="size-3.5" />
        <span className="sr-only">Search Cubby</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onSearchClick}
        onPointerEnter={preloadCommandMenu}
        onFocus={preloadCommandMenu}
        onTouchStart={preloadCommandMenu}
        className="ml-auto hidden h-8 min-w-52 justify-start px-2 text-muted-foreground lg:flex"
        aria-label="Search"
      >
        <Search className="size-3.5" />
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

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 border-r border-border bg-card md:flex md:w-[var(--app-sidebar-collapsed-width)] md:flex-col lg:transition-[width] lg:duration-150 print:hidden",
        expanded
          ? "lg:w-[var(--app-sidebar-expanded-width)]"
          : "lg:w-[var(--app-sidebar-collapsed-width)]",
      )}
      aria-label="Workspace navigation"
    >
      <div className="flex h-12 items-center border-b border-border px-2">
        <Link
          to="/"
          aria-label="Cubby home"
          className="flex min-w-0 items-center gap-2"
        >
          <img src={LOGO_SRC} alt="" className="size-6 shrink-0" />
          {expanded && (
            <span className="hidden truncate font-heading text-lg font-semibold tracking-tight lg:block">
              cubby
            </span>
          )}
        </Link>
      </div>
      <nav
        className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
        aria-label="Cubby"
      >
        <SidebarHome active={activeTo === homeNavItem.to} expanded={expanded} />
        <SidebarToday activeTo={activeTo} expanded={expanded} />
        {primaryNavGroups.map((group) => (
          <SidebarGroup
            key={group.label}
            group={group}
            expanded={expanded}
            activeTo={activeTo}
          />
        ))}
      </nav>
      <div className="border-t border-border p-2">
        <SidebarUtilityLinks
          expanded={expanded}
          activeTo={activeTo}
          onOpenUtility={() => {
            setUtilityMounted(true);
            setUtilityOpen(true);
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onToggle}
          className="hidden h-8 w-full justify-center px-2 lg:flex"
          aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
          title={expanded ? "Collapse sidebar" : "Expand sidebar"}
        >
          {expanded ? <ChevronLeft /> : <ChevronRight />}
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

function SidebarUtilityLinks({
  expanded,
  activeTo,
  onOpenUtility,
}: {
  expanded: boolean;
  activeTo: string | undefined;
  onOpenUtility: () => void;
}) {
  return (
    <div className="mb-1 border-b border-border pb-1">
      <div className={cn("md:block", expanded && "lg:hidden")}>
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
          onClick={onOpenUtility}
          className="mb-1 size-10"
          aria-label="Tools & data"
          title="Tools & data"
        >
          <Wrench />
        </Button>
        <div className="flex size-10 items-center justify-center">
          <Suspense fallback={<div className="size-7" aria-hidden="true" />}>
            <ShellAccount />
          </Suspense>
        </div>
      </div>
      {expanded && (
        <div className="hidden lg:block">
          <SidebarFullLeaf
            item={settingsNavItem}
            active={activeTo === settingsNavItem.to}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onOpenUtility}
            className="mb-1 h-8 w-full justify-start gap-2 px-2 text-muted-foreground"
          >
            <Wrench className="size-3.5" />
            <span className="truncate">Tools & data</span>
          </Button>
          <div className="flex h-8 items-center gap-2 px-2 text-xs text-muted-foreground">
            <Suspense fallback={<div className="size-7" aria-hidden="true" />}>
              <ShellAccount />
            </Suspense>
            <span>Account</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SidebarToday({
  activeTo,
  expanded,
}: {
  activeTo: string | undefined;
  expanded: boolean;
}) {
  return (
    <section className="mb-4 border-y border-border py-2" aria-label="Today">
      {expanded && <p className="hidden px-2 pb-1 eyebrow lg:block">Today</p>}
      {todayNavItems.map((item) => (
        <div key={item.to}>
          <div className={cn("md:block", expanded && "lg:hidden")}>
            <Suspense fallback={<SidebarRailLeafFallback item={item} />}>
              <RailLeaf item={item} active={activeTo === item.to} />
            </Suspense>
          </div>
          {expanded && (
            <div className="hidden lg:block">
              <SidebarFullLeaf item={item} active={activeTo === item.to} />
            </div>
          )}
        </div>
      ))}
    </section>
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
}: {
  group: NavGroup;
  expanded: boolean;
  activeTo: string | undefined;
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
          <SidebarExpandedDomainGroup group={group} activeTo={activeTo} />
        </div>
      )}
    </>
  );
}

/** The expanded rail is a direct route index; collapsed mode keeps the flyout. */
function SidebarExpandedDomainGroup({
  group,
  activeTo,
}: {
  group: NavGroup;
  activeTo: string | undefined;
}) {
  const domain = group.domain ? domainWayfinding(group.domain) : null;
  const Icon = group.icon;

  return (
    <section
      className="mb-4 border-l pl-2"
      style={
        domain ? { borderLeftColor: `var(${domain.accentToken})` } : undefined
      }
      aria-label={group.label}
    >
      <div className="mb-1 flex h-6 items-center gap-2 text-xs font-medium text-foreground">
        <span
          style={domain ? { color: `var(${domain.accentToken})` } : undefined}
          aria-hidden="true"
        >
          <Icon className="size-3.5" />
        </span>
        <span>{group.label}</span>
      </div>
      {group.children.map((item) => (
        <SidebarFullLeaf
          key={item.to}
          item={item}
          active={activeTo === item.to}
        />
      ))}
    </section>
  );
}

function SidebarRailGroupFallback({ group }: { group: NavGroup }) {
  const Icon = group.icon;
  return (
    <button
      type="button"
      className="mb-1 flex size-10 items-center justify-center border border-transparent text-muted-foreground"
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
        "mb-1 flex h-8 min-w-0 items-center gap-2 border border-transparent px-2 text-xs transition-colors hover:bg-muted hover:text-foreground",
        !active && "text-muted-foreground",
        active && "border-border bg-background font-medium text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{item.label}</span>
    </Link>
  );
}

function SidebarRailLeafFallback({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      className="mb-1 flex size-10 items-center justify-center border border-transparent text-muted-foreground"
      aria-label={item.label}
      title={item.label}
      disabled
    >
      <Icon className="size-3.5" />
    </button>
  );
}
