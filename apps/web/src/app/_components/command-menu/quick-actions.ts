import type { LucideIcon } from "lucide-react";
import { ChefHat, MapPin, Plus, ScanBarcode, Settings } from "lucide-react";

export interface QuickAction {
  id: string;
  name: string;
  path: string;
  icon: LucideIcon;
  keywords?: string[];
}

export const quickActions: QuickAction[] = [
  {
    id: "add-inventory",
    name: "Add Inventory",
    path: "/inventory/quick-capture",
    icon: ScanBarcode,
    keywords: ["barcode", "scan", "inventory", "add", "fast", "capture"],
  },
  {
    id: "scanner",
    name: "Scanner Mode",
    path: "/inventory/quick-capture?scanner=true",
    icon: ScanBarcode,
    keywords: ["barcode", "scan", "camera"],
  },
  {
    id: "add-product",
    name: "Add Product",
    path: "/products/new",
    icon: Plus,
    keywords: ["create", "new", "item"],
  },
  {
    id: "add-recipe",
    name: "Add Recipe",
    path: "/recipes/new",
    icon: ChefHat,
    keywords: ["create", "new", "cooking"],
  },
  {
    id: "add-location",
    name: "Add Location",
    path: "/locations/new",
    icon: MapPin,
    keywords: ["create", "new", "place", "room"],
  },
  {
    id: "api-panel",
    name: "API Panel",
    path: "/api/panel",
    icon: Settings,
    keywords: ["developer", "debug", "admin"],
  },
];
