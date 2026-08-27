import type { Entity } from "@cubby/schemas/entity";
import type { ReactNode } from "react";
import { CommandGroup, CommandItem } from "~/components/ui/command";
import { verbDef } from "../actions/action-verbs";
import {
  type EntityActionRow,
  useEntityActions,
} from "../actions/entity-actions";

export interface PaletteAction {
  verb: Parameters<typeof verbDef>[0];
  run: (row: EntityActionRow) => void;
}

/**
 * Host for the palette's "do something to this record" actions.
 *
 * Render-prop rather than a plain component, and it wraps the palette instead
 * of sitting inside it, because selecting an action closes the palette: a
 * dialog mounted within `CommandDialog` would unmount in the same commit that
 * opened it, and the action would silently do nothing. The host stays mounted,
 * so `{dialogs}` survives the close.
 */
function ResolvedHost({
  entity,
  children,
}: {
  entity: Entity;
  children: (actions: PaletteAction[]) => ReactNode;
}) {
  const { singleRecordActions, dialogs } = useEntityActions(entity);
  return (
    <>
      {children(singleRecordActions)}
      {dialogs}
    </>
  );
}

const NO_ACTIONS: PaletteAction[] = [];

/**
 * `key={entity}` is load-bearing: `useEntityActions` invokes one hook per
 * matching definition, so the entity has to be constant for an instance.
 * Remounting as the typed shortcode changes is what keeps that true.
 */
export function EntityPaletteActionsHost({
  entity,
  children,
}: {
  entity: Entity | null;
  children: (actions: PaletteAction[]) => ReactNode;
}) {
  if (!entity) return <>{children(NO_ACTIONS)}</>;
  return (
    <ResolvedHost key={entity} entity={entity}>
      {children}
    </ResolvedHost>
  );
}

/** The palette group itself, rendered inside the command list. */
export function EntityPaletteActionGroup({
  actions,
  shortcode,
  name,
  onRun,
}: {
  actions: PaletteAction[];
  shortcode: string;
  name?: string | null;
  onRun: () => void;
}) {
  if (actions.length === 0) return null;
  return (
    <CommandGroup heading="Actions">
      {actions.map((action) => {
        const { label, icon: Icon } = verbDef(action.verb);
        return (
          <CommandItem
            key={action.verb}
            onSelect={() => {
              action.run({ id: shortcode, name });
              onRun();
            }}
            className="flex items-center gap-2"
          >
            <Icon className="size-4" />
            <span>{label}</span>
            <span className="ml-auto font-mono text-muted-foreground text-xs">
              {shortcode}
            </span>
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}
