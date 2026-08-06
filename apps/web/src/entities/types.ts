import type { LucideIcon } from "lucide-react";

interface EntityRoutes {
  detail: string;
  list: string;
  new?: string;
}

type CommonSectionType = "images" | "history" | "unit-mappings";

type StandardColumnType = "image" | "name";

interface EntityDetailConfig {
  commonSections?: CommonSectionType[];
}

interface EntityListConfig {
  hasUnitMappings?: boolean;
  defaultSort?: string;
  standardColumns?: StandardColumnType[];
}

interface EntityColor {
  accent: string;
  bg: string;
  text: string;
  border: string;
}

export interface EntityDefinition {
  label: string;
  basePath: string;
  pluralLabel: string;
  lucideIcon: LucideIcon;
  color: EntityColor;
  routes: EntityRoutes;
  detail?: EntityDetailConfig;
  list?: EntityListConfig;
}
