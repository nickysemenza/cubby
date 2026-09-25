import { getCategoryColor, getFeatureColor } from "@cubby/shared";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { BookOpenIcon } from "@phosphor-icons/react/dist/csr/BookOpen";
import { CouchIcon } from "@phosphor-icons/react/dist/csr/Couch";
import { CpuIcon } from "@phosphor-icons/react/dist/csr/Cpu";
import { DiscIcon } from "@phosphor-icons/react/dist/csr/Disc";
import { ForkKnifeIcon } from "@phosphor-icons/react/dist/csr/ForkKnife";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { LightningIcon } from "@phosphor-icons/react/dist/csr/Lightning";
import { PackageIcon } from "@phosphor-icons/react/dist/csr/Package";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { TShirtIcon } from "@phosphor-icons/react/dist/csr/TShirt";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";
import type { Icon } from "@phosphor-icons/react/lib";

// Re-export colors/helpers from @cubby/shared for existing consumers
export { getCategoryColor, getFeatureColor };

const featureIcons = {
  food: ForkKnifeIcon,
  tools: WrenchIcon,
  "tool-consumables": DiscIcon,
  "tool-accessories": GearIcon,
  storage: ArchiveIcon,
  hardware: LightningIcon,
  electronics: CpuIcon,
  software: PackageIcon,
  books: BookOpenIcon,
  household: CouchIcon,
  supplies: SparkleIcon,
  apparel: TShirtIcon,
} satisfies Record<string, Icon>;

/**
 * Get the icon component for a product category
 */
export const getCategoryIcon = (feature: string | null | undefined): Icon =>
  Object.entries(featureIcons).find(([key]) => key === feature)?.[1] ??
  PackageIcon;
