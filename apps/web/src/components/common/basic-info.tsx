import type { FC, ReactNode } from "react";
import { Stack } from "~/components/layout";
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
    <Stack gap="sm">
      {header}
      {/* Fact sheet: each InfoRow carries its own dotted leader — no dividers */}
      <div>
        {visibleFields.map((field) => (
          <InfoRow key={field.label} label={field.label}>
            {field.value}
          </InfoRow>
        ))}
      </div>
      {footer}
      {actions && <div className="pt-2">{actions}</div>}
    </Stack>
  );
};
