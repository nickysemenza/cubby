import type { FC, ReactNode } from "react";
import { InfoRow } from "./info-row";

export interface BasicInfoField {
  label: string;
  value: ReactNode;
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
    <div className="space-y-2">
      {header}
      {/* Fact sheet: dashed ledger rules between rows (see InfoRow) */}
      <div className="divide-y divide-dashed divide-border">
        {visibleFields.map((field) => (
          <InfoRow key={field.label} label={field.label}>
            {field.value}
          </InfoRow>
        ))}
      </div>
      {footer}
      {actions && <div className="pt-2">{actions}</div>}
    </div>
  );
};
