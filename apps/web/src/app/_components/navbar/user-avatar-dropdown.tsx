import { GearIcon as Settings } from "@phosphor-icons/react/dist/csr/Gear";
import { PlugIcon as Plug } from "@phosphor-icons/react/dist/csr/Plug";
import { SignOutIcon as LogOut } from "@phosphor-icons/react/dist/csr/SignOut";
import { UserIcon as User } from "@phosphor-icons/react/dist/csr/User";
import { Link } from "@tanstack/react-router";

import { Avatar, AvatarFallback, AvatarImage } from "~/components/ui/avatar";
import { Description } from "~/components/ui/description";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useHydrated } from "~/hooks/useHydrated";
import { authClient } from "~/lib/auth-client";

export const UserAvatarDropdown = () => {
  const hydrated = useHydrated();
  const session = authClient.useSession();
  const user = session.data?.user;

  // The better-auth session store can resolve *before* React hydrates, so the
  // real avatar trigger would render on the first client pass while SSR emitted
  // the placeholder → hydration mismatch (CUBBY-2). Gate on useHydrated() so the
  // first client render is byte-identical to SSR (always the placeholder).
  if (!hydrated || !user) {
    return (
      <div
        className="size-10 animate-pulse rounded-full bg-muted/60 md:size-7"
        aria-hidden
      />
    );
  }

  const getInitials = (name: string | null | undefined) => {
    if (!name) return "?";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex size-10 items-center justify-center focus:outline-none md:size-7"
        aria-label="Account menu"
      >
        <Avatar size="sm">
          {user.image && <AvatarImage src={user.image} alt={user.name ?? ""} />}
          <AvatarFallback>{getInitials(user.name)}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm leading-none font-medium">{user.name}</p>
              <Description size="xs" className="leading-none">
                {user.email}
              </Description>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuItem
            render={
              <Link
                to="/account/$accountView"
                params={{ accountView: "settings" }}
              />
            }
          >
            <User />
            <span>Account</span>
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/account/connected-apps" />}>
            <Plug />
            <span>Connected apps</span>
          </DropdownMenuItem>
          <DropdownMenuItem render={<Link to="/settings" />}>
            <Settings />
            <span>Settings</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => authClient.signOut()}
          variant="destructive"
        >
          <LogOut />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
