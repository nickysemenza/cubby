import React from "react";
import { NoneState } from "./NoneState";

interface EntityPillLinkListProps<T, P extends { [K in keyof P]: unknown }> {
  items?: T[];
  Pill: React.ComponentType<P>;
  pillPropName: keyof P;
  getKey?: (item: T) => string | number;
}

export function EntityPillLinkList<T, P extends { [K in keyof P]: unknown }>({
  items,
  Pill,
  pillPropName,
}: EntityPillLinkListProps<T, P>) {
  if (!items || items.length === 0) {
    return <NoneState />;
  }

  return (
    <div className="space-y-2">
      {items.map((item, x) => (
        <div key={x}>
          <Pill {...({ [pillPropName]: item } as P)} />
        </div>
      ))}
    </div>
  );
}
