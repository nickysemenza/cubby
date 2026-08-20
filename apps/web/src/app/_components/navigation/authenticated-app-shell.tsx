import { Link, useLocation } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Search, Wrench } from "lucide-react";
import { lazy, type ReactNode, Suspense, useState } from "react";
import { preloadCommandMenu } from "~/app/_components/command-menu-loader";
import { AppFooter } from "~/app/_components/footer";
import { MainNav } from "~/app/_components/MainNav";
import { Button } from "~/components/ui/button";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
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

const LOGO_SRC = import.meta.env.DEV ? "/favicon-dev.svg" : "/favicon.svg";

const ShellControls = lazy(() =>
  import("./authenticated-shell-controls").then((module) => ({
    default: module.AuthenticatedShellControls,
  })),
);
const ShellAccount = lazy(() =>
  import("./authenticated-shell-controls").then((module) => ({
    default: module.AuthenticatedShellAccount,
  })),
);
const RailGroupFlyout = lazy(() =>
  import("./sidebar-rail-group").then((module) => ({
    default: module.SidebarRailGroup,
  })),
);
const RailLeaf = lazy(() =>
  import("./sidebar-rail-group").then((module) => ({
    default: module.SidebarRailLeaf,
  })),
);
const WorkspaceNavigator = lazy(() =>
  import("./workspace-navigator").then((module) => ({
    default: module.WorkspaceNavigator,
  })),
);

type AuthenticatedAppShellProps = {
  children: ReactNode;
  mainContentId: string;
  navigationProgress: ReactNode;
  onSearchClick: () => void;
};

/**
 * The authenticated workspace frame. The md rail is intentionally forced: a
 * person's wide/compact preference applies only when there is space for the
 * full 224px sidebar, and a tablet visit must never overwrite that preference.
 */
export function AuthenticatedAppShell({
  children,
  mainContentId,
  navigationProgress,
  onSearchClick,
}: AuthenticatedAppShellProps) {
  const [collapsed, setCollapsed] = useLocalStorage(
    "app-shell:sidebar-collapsed",
    false,
  );
  const expanded = !collapsed;
  const viewportSurface = useLocation().pathname === "/pantry-view";

  return (
    <div className="min-h-dvh bg-background [--app-chrome-bottom:calc(3.5rem+3px+env(safe-area-inset-bottom))] [--app-chrome-top:calc(3rem+3px+env(safe-area-inset-top))] md:flex md:[--app-chrome-bottom:0rem] md:[--app-chrome-top:3rem]">
      <WorkspaceSidebar
        expanded={expanded}
        onToggle={() => setCollapsed((value) => !value)}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phone PWA keeps the familiar masthead; its bottom bar stays mounted
            by the root route and remains the primary phone navigation. */}
        <div className="safe-top sticky top-0 z-40 border-b-[3px] border-b-foreground bg-card md:hidden print:hidden">
          <div className="flex h-12 w-full items-center px-2">
            <MainNav onSearchClick={onSearchClick} />
          </div>
          {navigationProgress}
        </div>
        <DesktopCommandHeader
          onSearchClick={onSearchClick}
          navigationProgress={navigationProgress}
        />
        {/* Flush to the rail and the command header: the table's own border
            is the page edge, so main spends no gutter. The 5rem bottom stays
            for the phone's fixed bottom nav, which would otherwise cover the
            last rows. */}
        <main
          id={mainContentId}
          tabIndex={-1}
          className={cn(
            "min-w-0 flex-1",
            viewportSurface ? "overflow-hidden" : "pb-20 md:pb-0",
          )}
        >
          {children}
        </main>
        {!viewportSurface && <AppFooter />}
      </div>
    </div>
  );
}

function DesktopCommandHeader({
  onSearchClick,
  navigationProgress,
}: Pick<AuthenticatedAppShellProps, "onSearchClick" | "navigationProgress">) {
  return (
    <header className="sticky top-0 z-40 hidden h-12 items-center border-b-[3px] border-b-foreground bg-card px-4 md:flex md:px-6 print:hidden">
      <p className="font-heading font-semibold text-sm">Cubby workspace</p>
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
        "sticky top-0 hidden h-dvh shrink-0 border-border border-r bg-card md:flex md:w-14 md:flex-col lg:transition-[width] lg:duration-150 print:hidden",
        expanded ? "lg:w-36" : "lg:w-14",
      )}
      aria-label="Workspace navigation"
    >
      <div className="flex h-12 items-center border-border border-b px-2">
        <Link to="/" className="flex min-w-0 items-center gap-2">
          <img src={LOGO_SRC} alt="" className="size-6 shrink-0" />
          {expanded && (
            <span className="hidden truncate font-heading font-semibold text-lg tracking-tight lg:block">
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
      <div className="border-border border-t p-2">
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
    <div className="mb-1 border-border border-b pb-1">
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
          <div className="flex h-8 items-center gap-2 px-2 text-muted-foreground text-xs">
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
    <section className="mb-4 border-border border-y py-2" aria-label="Today">
      {expanded && <p className="eyebrow hidden px-2 pb-1 lg:block">Today</p>}
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
          <Suspense fallback={<SidebarRailGroupFallback group={group} />}>
            <RailGroupFlyout group={group} activeTo={activeTo} expanded />
          </Suspense>
        </div>
      )}
    </>
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
        "mb-1 flex h-8 items-center gap-2 border border-transparent px-2 text-xs transition-colors hover:bg-muted hover:text-foreground",
        !active && "text-muted-foreground",
        active && "border-border bg-background font-medium text-foreground",
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{item.railLabel ?? item.label}</span>
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
