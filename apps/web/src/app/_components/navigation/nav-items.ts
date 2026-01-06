import {
  Activity,
  AlertTriangle,
  ExternalLink,
  Home,
  LayoutDashboard,
  Plug,
  ScanBarcode,
  TrendingUp,
} from "lucide-react";
import { entities } from "~/entities/entities";

export type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  isActive: (pathname: string) => boolean;
};

// Define each item once
const scan: NavItem = {
  href: "/inventory/scanner",
  label: "Scan",
  icon: ScanBarcode,
  isActive: (p) => p === "/inventory/scanner",
};

const inventory: NavItem = {
  href: "/inventory",
  label: "Inventory",
  icon: entities.inventory.lucideIcon,
  isActive: (p) => p.startsWith("/inventory") && p !== "/inventory/scanner",
};

const locations: NavItem = {
  href: "/locations",
  label: "Locations",
  icon: entities.location.lucideIcon,
  isActive: (p) => p.startsWith("/locations"),
};

const recipes: NavItem = {
  href: "/recipes",
  label: "Recipes",
  icon: entities.recipe.lucideIcon,
  isActive: (p) => p.startsWith("/recipes"),
};

const products: NavItem = {
  href: "/products",
  label: "Products",
  icon: entities.product.lucideIcon,
  isActive: (p) => p.startsWith("/products"),
};

const home: NavItem = {
  href: "/",
  label: "Home",
  icon: Home,
  isActive: (p) => p === "/",
};

const ingredients: NavItem = {
  href: "/ingredients",
  label: "Ingredients",
  icon: entities.ingredient.lucideIcon,
  isActive: (p) => p.startsWith("/ingredients"),
};

const usda: NavItem = {
  href: "/usda",
  label: "USDA Foods",
  icon: entities["usda-food"].lucideIcon,
  isActive: (p) => p.startsWith("/usda"),
};

const dashboard: NavItem = {
  href: "/dashboard",
  label: "Dashboard",
  icon: LayoutDashboard,
  isActive: (p) => p === "/dashboard",
};

const activity: NavItem = {
  href: "/activity",
  label: "Activity",
  icon: Activity,
  isActive: (p) => p.startsWith("/activity"),
};

const insights: NavItem = {
  href: "/insights",
  label: "Insights",
  icon: TrendingUp,
  isActive: (p) => p.startsWith("/insights"),
};

const problems: NavItem = {
  href: "/problems",
  label: "Problems",
  icon: AlertTriangle,
  isActive: (p) => p.startsWith("/problems"),
};

const images: NavItem = {
  href: "/images",
  label: "Images",
  icon: entities.image.lucideIcon,
  isActive: (p) => p.startsWith("/images"),
};

const integrations: NavItem = {
  href: "/settings/integrations",
  label: "Integrations",
  icon: Plug,
  isActive: (p) => p.startsWith("/settings/integrations"),
};

const apiPanel: NavItem = {
  href: "/api/panel",
  label: "API Panel",
  icon: ExternalLink,
  isActive: () => false,
};

// Export groupings for consumers
export const bottomNavItems: NavItem[] = [
  scan,
  inventory,
  locations,
  recipes,
  products,
];

export const moreNavItems: NavItem[] = [
  home,
  ingredients,
  usda,
  dashboard,
  activity,
  insights,
  problems,
  images,
  integrations,
];

export const kitchenItems: NavItem[] = [ingredients, recipes, usda];

export const reportsItems: NavItem[] = [
  dashboard,
  activity,
  insights,
  problems,
];

export const desktopMoreItems: NavItem[] = [images, integrations, apiPanel];
