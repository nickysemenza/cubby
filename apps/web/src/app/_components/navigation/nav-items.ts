import {
  Activity,
  AlertTriangle,
  BookOpen,
  Camera,
  FileText,
  Hammer,
  Home,
  LayoutDashboard,
  Palette,
  ScanBarcode,
  Search,
  Settings,
  Sparkles,
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
  label: "Scan UPC",
  icon: ScanBarcode,
  isActive: (p) => p === "/inventory/quick-capture",
};

const captureShelf: NavItem = {
  href: "/capture",
  label: "Capture shelf",
  icon: Camera,
  isActive: (p) => p.startsWith("/capture"),
};

export const inventory: NavItem = {
  href: "/inventory",
  label: "Inventory",
  icon: entities.inventory.lucideIcon,
  isActive: (p) =>
    p.startsWith("/inventory") && p !== "/inventory/quick-capture",
};

export const locations: NavItem = {
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
  href: "/meals",
  label: "Meals",
  icon: Utensils,
  // The calendar + everything under /meals EXCEPT the suggestions surface,
  // which has its own nav item below.
  isActive: (p) => p.startsWith("/meals") && p !== "/meals/suggestions",
};

const mealSuggestions: NavItem = {
  href: "/meals/suggestions",
  label: "What can I make?",
  icon: Sparkles,
  isActive: (p) => p === "/meals/suggestions",
};

const search: NavItem = {
  href: "/search",
  label: "Search",
  icon: Search,
  isActive: (p) => p.startsWith("/search"),
};

export const products: NavItem = {
  href: "/products",
  label: "Products",
  icon: entities.product.lucideIcon,
  isActive: (p) => p.startsWith("/products"),
};

export const home: NavItem = {
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

const aiSmokeTest: NavItem = {
  href: "/ai-smoke-test",
  label: "AI smoke test",
  icon: Sparkles,
  isActive: (p) => p.startsWith("/ai-smoke-test"),
};

const images: NavItem = {
  href: "/images",
  label: "Images",
  icon: entities.image.lucideIcon,
  isActive: (p) => p.startsWith("/images"),
};

export const projects: NavItem = {
  href: "/projects",
  label: "Projects",
  icon: Hammer,
  isActive: (p) => p.startsWith("/projects"),
};

const settings: NavItem = {
  href: "/settings",
  label: "Settings",
  icon: Settings,
  isActive: (pathname) => pathname.startsWith("/settings"),
};

// Public routes reachable without signing in (see _authenticated layout guard).
export const docs: NavItem = {
  href: "/docs",
  label: "Docs",
  icon: FileText,
  isActive: (p) => p.startsWith("/docs"),
};

export const design: NavItem = {
  href: "/design",
  label: "Design",
  icon: Palette,
  isActive: (p) => p.startsWith("/design"),
};

// Export groupings for consumers

// Shown in the navbar when signed out — only routes that don't require auth.
export const publicNavItems: NavItem[] = [home, docs, design];

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
  aiSmokeTest,
  images,
  settings,
];

export const kitchenItems: NavItem[] = [
  ingredients,
  recipes,
  cookbooks,
  meals,
  mealSuggestions,
  usda,
];

export const reportsItems: NavItem[] = [
  dashboard,
  activity,
  insights,
  problems,
  aiSmokeTest,
];

export const desktopMoreItems: NavItem[] = [captureShelf, images, settings];
