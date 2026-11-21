import type { Entity } from "@cubby/schemas/entity";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import {
  entities,
  entityDetailParams,
  isBrowserRoutedEntity,
} from "~/entity/entities";

interface Sequence {
  ids: readonly string[];
  total: number;
}

/**
 * The rows of the list the member last read for each entity, in its order. It
 * lives for the page session only: a record opened without a list has no
 * neighbours, and its page offers no stepper.
 */
const sequences = new Map<Entity, Sequence>();

/** A page-level list reports its loaded rows, in order, as it reads them. */
export function useRememberRecordSequence(
  entity: Entity,
  rows: readonly { id: string }[] | undefined,
  total: number | undefined,
) {
  useEffect(() => {
    if (!rows?.length) return;
    sequences.set(entity, {
      ids: rows.map((row) => row.id),
      total: total ?? rows.length,
    });
  }, [entity, rows, total]);
}

/**
 * Where a record sits in the list the member came from, and the step to its
 * neighbours. Null when the record is not among that list's loaded rows.
 */
export function useRecordSequence(entity: Entity, id: string) {
  const navigate = useNavigate();
  const sequence = sequences.get(entity);
  const index = sequence?.ids.indexOf(id) ?? -1;
  if (!sequence || index === -1 || !isBrowserRoutedEntity(entity)) return null;
  const at = (delta: number) => sequence.ids[index + delta];
  return {
    index,
    total: sequence.total,
    previous: at(-1) !== undefined,
    next: at(1) !== undefined,
    go(delta: -1 | 1) {
      const target = at(delta);
      if (target === undefined) return;
      void navigate({
        to: entities[entity].routes.detail,
        params: entityDetailParams(target),
      });
    },
  };
}
