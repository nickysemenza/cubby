import { Link } from "@tanstack/react-router";
import {
  Barcode,
  MapPin,
  Package,
  Plus,
  ScanBarcode,
  UtensilsCrossed,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/ui/tooltip";

const quickActions = [
  {
    label: "New Product",
    href: "/products/new",
    icon: Package,
  },
  {
    label: "New Location",
    href: "/locations/new",
    icon: MapPin,
  },
  {
    label: "New Recipe",
    href: "/recipes/new",
    icon: UtensilsCrossed,
  },
  {
    label: "Scanner",
    href: "/inventory/scanner",
    icon: ScanBarcode,
    description: "Quick scan & add",
  },
  {
    label: "Quick Capture",
    href: "/inventory/quick-capture",
    icon: Barcode,
    description: "Batch entry",
  },
];

export const QuickActionsMenu = () => {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={<Button variant="ghost" size="sm" className="h-8 px-2" />}
            />
          }
        >
          <Plus className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent>
          <p>Quick actions</p>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Create</DropdownMenuLabel>
          {quickActions.map((action) => (
            <DropdownMenuItem
              key={action.href}
              render={<Link to={action.href} />}
            >
              <action.icon className="h-4 w-4" />
              <span>{action.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
