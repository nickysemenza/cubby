import type { FC, ReactNode } from "react";

import { Stack } from "~/components/layout";

export interface BasicInfoField {
  label: string;
  value: ReactNode;
  /** Secondary browse/filter action kept outside editable values and links. */
  filterAction?: ReactNode;
  hide?: boolean;
}

interface BasicInfoProps {
  fields: BasicInfoField[];
  header?: ReactNode;
  footer?: ReactNode;
  actions?: ReactNode;
}

export const BasicInfo: FC<BasicInfoProps> = ({
  fields,
  header,
  footer,
  actions,
}) => {
  const visibleFields = fields.filter((f) => !f.hide && f.value !== undefined);

  return (
    <Stack gap="sm">
      {header}
      <div className="basic-info-ledger">
        {visibleFields.map((field) => (
          <div
            key={field.label}
            className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-baseline gap-2 border-b border-border py-1.5" /* tight */
          >
            <span className="min-w-0 eyebrow">{field.label}</span>
            <span className="min-w-0 text-xs">{field.value}</span>
            {field.filterAction}
          </div>
        ))}
      </div>
      {footer}
      {actions && <div className="pt-2">{actions}</div>}
    </Stack>
  );
};
