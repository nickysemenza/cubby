import type { LucideIcon } from "lucide-react";
import {
  AlertTriangle,
  ArrowRightLeft,
  ChefHat,
  ClipboardCheck,
  MapPin,
  Plus,
  Printer,
  ScanBarcode,
} from "lucide-react";

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
    name: "Inventory Session",
    path: "/inventory/session",
    icon: ScanBarcode,
    keywords: ["barcode", "scan", "inventory", "add", "garage", "audit"],
  },
  {
    id: "scanner",
    name: "Scan Inventory",
    path: "/inventory/session",
    icon: ScanBarcode,
    keywords: ["barcode", "scan", "camera", "bin"],
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
    id: "bulk-move",
    name: "Bulk Move Inventory",
    path: "/inventory/bulk-move",
    icon: ArrowRightLeft,
    keywords: ["move", "transfer", "relocate", "inventory"],
  },
  {
    id: "problems",
    name: "Problems",
    path: "/problems",
    icon: AlertTriangle,
    keywords: ["issues", "errors", "warnings", "audit"],
  },
  {
    id: "inventory-audit",
    name: "Inventory Audit",
    path: "/inventory/bulk-edit",
    icon: ClipboardCheck,
    keywords: ["audit", "bulk", "edit", "inventory", "review"],
  },
  {
    id: "print-labels",
    name: "Print Labels",
    path: "/labels",
    icon: Printer,
    keywords: ["label", "print", "qr", "barcode", "sticker"],
  },
];
