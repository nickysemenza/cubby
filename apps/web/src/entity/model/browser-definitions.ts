import { entityRoster } from "@cubby/schemas/entity-roster";

import { PHOSPHOR_ICONS } from "../generated/entity-icon-data.gen";
import {
  generatedBrowserRoutes,
  generatedBrowserCrudEntities,
} from "../generated/entity-routes.gen";
import type { EntityColor } from "../types";

export type GeneratedBrowserCrudEntity =
  (typeof generatedBrowserCrudEntities)[number];

export const generatedBrowserDefinitions = (color: EntityColor) => {
  // SAFETY: each generated route key has a roster entry and an imported icon.
  // Object.fromEntries erases only the route-key correlation.
  return Object.fromEntries(
    Object.entries(generatedBrowserRoutes).map(([key, routes]) => {
      // SAFETY: Object.entries enumerates exactly the generated route keys.
      const entity = key as keyof typeof generatedBrowserRoutes;
      const roster = entityRoster[entity];
      return [
        entity,
        {
          ...routes,
          label: roster.singular,
          pluralLabel: roster.plural,
          phosphorIcon: PHOSPHOR_ICONS[roster.icons.phosphor],
          color,
        },
      ];
    }),
  ) as {
    [
      E in keyof typeof generatedBrowserRoutes
    ]: (typeof generatedBrowserRoutes)[E] & {
      label: (typeof entityRoster)[E]["singular"];
      pluralLabel: (typeof entityRoster)[E]["plural"];
      phosphorIcon: (typeof PHOSPHOR_ICONS)[keyof typeof PHOSPHOR_ICONS];
      color: EntityColor;
    };
  };
};
