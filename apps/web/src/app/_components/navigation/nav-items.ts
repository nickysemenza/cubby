import {
  Activity,
  AlertTriangle,
  BookOpen,
  Camera,
  ExternalLink,
  Hammer,
  Home,
  LayoutDashboard,
  ScanBarcode,
  Search,
  Settings,
  TrendingUp,
  Utensils,
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
  href: "/inventory/quick-capture?scanner=true",
  label: "Scan",
  icon: ScanBarcode,
  isActive: (p) => p === "/inventory/quick-capture",
};

const captureShelf: NavItem = {
  href: "/capture",
  label: "Scan a shelf",
  icon: Camera,
  isActive: (p) => p.startsWith("/capture"),
};

const inventory: NavItem = {
  href: "/inventory",
  label: "Inventory",
  icon: entities.inventory.lucideIcon,
  isActive: (p) =>
    p.startsWith("/inventory") && p !== "/inventory/quick-capture",
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

const cookbooks: NavItem = {
  href: "/cookbooks",
  label: "Cookbooks",
  icon: BookOpen,
  isActive: (p) => p.startsWith("/cookbooks"),
};

const meals: NavItem = {
  href: "/meals/suggestions",
  label: "Meals",
  icon: Utensils,
  isActive: (p) => p.startsWith("/meals"),
};

const search: NavItem = {
  href: "/search",
  label: "Search",
  icon: Search,
  isActive: (p) => p.startsWith("/search"),
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

const projects: NavItem = {
  href: "/projects",
  label: "Projects",
  icon: Hammer,
  isActive: (p) => p.startsWith("/projects"),
};

const apiPanel: NavItem = {
  href: "/api/panel",
  label: "API Panel",
  icon: ExternalLink,
  isActive: () => false,
};

const settings: NavItem = {
  href: "/settings",
  label: "Settings",
  icon: Settings,
  isActive: (pathname) => pathname.startsWith("/settings"),
};

// Export groupings for consumers
export const bottomNavItems: NavItem[] = [
  scan,
  inventory,
  locations,
  recipes,
  search,
];

export const moreNavItems: NavItem[] = [
  home,
  captureShelf,
  products,
  ingredients,
  usda,
  projects,
  dashboard,
  activity,
  insights,
  problems,
  images,
];

export const kitchenItems: NavItem[] = [
  ingredients,
  recipes,
  cookbooks,
  meals,
  usda,
];

export const reportsItems: NavItem[] = [
  dashboard,
  activity,
  insights,
  problems,
];

export const desktopMoreItems: NavItem[] = [
  captureShelf,
  images,
  apiPanel,
  settings,
];
