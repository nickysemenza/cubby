import { useQueries } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Database,
  Image,
  MapPin,
  Package,
  ShoppingCart,
  Utensils,
} from "lucide-react";
import { Card } from "~/components/ui/card";
import { authClient } from "~/lib/auth-client";
import { cn } from "~/lib/utils";
import type { SortParams } from "~/schemas/pagination";
import { useTRPC } from "~/trpc/react";

interface StatCardProps {
  label: string;
  count: number | undefined;
  isLoading: boolean;
  icon: LucideIcon;
  href: string;
  color: string;
}

/** Format large numbers with compact notation (e.g., 2.1M, 15K) */
const compactFormatter = new Intl.NumberFormat("en", { notation: "compact" });
const formatCount = (count: number): string => compactFormatter.format(count);

function StatCard({
  label,
  count,
  isLoading,
  icon: Icon,
  href,
  color,
}: StatCardProps) {
  return (
    <Link to={href}>
      <Card
        className={cn(
          "p-2.5 transition-all duration-200",
          "hover:border-muted-foreground/30 hover:shadow-md",
          "cursor-pointer",
        )}
      >
        <div className="flex items-center gap-2">
          <div className={cn("rounded p-1.5", color)}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading ? (
              <div className="h-5 w-8 animate-pulse rounded bg-muted" />
            ) : (
              <p className="font-semibold text-base leading-none">
                {formatCount(count ?? 0)}
              </p>
            )}
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {label}
            </p>
          </div>
        </div>
      </Card>
    </Link>
  );
}

export default function EntityCount() {
  const api = useTRPC();
  const { data: activeOrg } = authClient.useActiveOrganization();

  const sort: SortParams = { orderBy: "name", direction: "asc" };
  const opts = {
    filters: {},
    sort,
    pagination: { pageIndex: 0, pageSize: 1 },
  };

  const [location, product, ingredient, recipe, inventoryItem, usda, image] =
    useQueries({
      queries: [
        { ...api.location.list.queryOptions(opts), enabled: !!activeOrg },
        { ...api.product.list.queryOptions(opts), enabled: !!activeOrg },
        { ...api.ingredient.list.queryOptions(opts), enabled: !!activeOrg },
        { ...api.recipe.list.queryOptions(opts), enabled: !!activeOrg },
        {
          ...api.inventoryItem.list.queryOptions(opts),
          enabled: !!activeOrg,
        },
        { ...api.usda.list.queryOptions(opts), enabled: !!activeOrg },
        { ...api.image.list.queryOptions(opts), enabled: !!activeOrg },
      ],
    });

  // Only render counts if there's an active organization
  if (!activeOrg) {
    return (
      <p className="text-muted-foreground text-sm">
        Select an organization to view entity counts
      </p>
    );
  }

  const stats = [
    {
      label: "Locations",
      count: location.data?.meta.totalCount,
      isLoading: location.isLoading,
      icon: MapPin,
      href: "/locations",
      color: "bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400",
    },
    {
      label: "Products",
      count: product.data?.meta.totalCount,
      isLoading: product.isLoading,
      icon: ShoppingCart,
      href: "/products",
      color:
        "bg-green-100 text-green-600 dark:bg-green-900/30 dark:text-green-400",
    },
    {
      label: "Inventory",
      count: inventoryItem.data?.meta.totalCount,
      isLoading: inventoryItem.isLoading,
      icon: Package,
      href: "/inventory",
      color:
        "bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400",
    },
    {
      label: "Recipes",
      count: recipe.data?.meta.totalCount,
      isLoading: recipe.isLoading,
      icon: BookOpen,
      href: "/recipes",
      color:
        "bg-purple-100 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400",
    },
    {
      label: "Ingredients",
      count: ingredient.data?.meta.totalCount,
      isLoading: ingredient.isLoading,
      icon: Utensils,
      href: "/ingredients",
      color: "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400",
    },
    {
      label: "Images",
      count: image.data?.meta.totalCount,
      isLoading: image.isLoading,
      icon: Image,
      href: "/images",
      color: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
    },
    {
      label: "USDA Foods",
      count: usda.data?.meta.totalCount,
      isLoading: usda.isLoading,
      icon: Database,
      href: "/usda",
      color: "bg-teal-100 text-teal-600 dark:bg-teal-900/30 dark:text-teal-400",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {stats.map((stat) => (
        <StatCard key={stat.label} {...stat} />
      ))}
    </div>
  );
}
