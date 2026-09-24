import {
  formatCategoryLabel,
  getCategoryColor,
  getFeatureColor,
} from "@cubby/shared";
import { ArchiveIcon as Archive } from "@phosphor-icons/react/dist/csr/Archive";
import { BookOpenIcon as BookOpen } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CouchIcon as Sofa } from "@phosphor-icons/react/dist/csr/Couch";
import { CpuIcon as Cpu } from "@phosphor-icons/react/dist/csr/Cpu";
import { DiscIcon as Disc } from "@phosphor-icons/react/dist/csr/Disc";
import { ForkKnifeIcon as Utensils } from "@phosphor-icons/react/dist/csr/ForkKnife";
import { GearIcon as Settings } from "@phosphor-icons/react/dist/csr/Gear";
import { LightningIcon as Bolt } from "@phosphor-icons/react/dist/csr/Lightning";
import { PackageIcon as Package } from "@phosphor-icons/react/dist/csr/Package";
import { SparkleIcon as Sparkles } from "@phosphor-icons/react/dist/csr/Sparkle";
import { TShirtIcon as Shirt } from "@phosphor-icons/react/dist/csr/TShirt";
import { WrenchIcon as Wrench } from "@phosphor-icons/react/dist/csr/Wrench";
import type { Icon } from "@phosphor-icons/react/lib";

// Re-export colors/helpers from @cubby/shared for existing consumers
export { formatCategoryLabel, getCategoryColor, getFeatureColor };

const featureIcons = {
  food: Utensils,
  tools: Wrench,
  "tool-consumables": Disc,
  "tool-accessories": Settings,
  storage: Archive,
  hardware: Bolt,
  electronics: Cpu,
  software: Package,
  books: BookOpen,
  household: Sofa,
  supplies: Sparkles,
  apparel: Shirt,
} satisfies Record<string, Icon>;

/**
 * Get the icon component for a product category
 */
export const getCategoryIcon = (feature: string | null | undefined): Icon =>
  Object.entries(featureIcons).find(([key]) => key === feature)?.[1] ?? Package;
