import { type FC, type ReactNode } from "react";

import { Stack } from "~/ui/layout";

import { Ledger, LedgerCell, LedgerRow } from "./ledger";

export interface BasicInfoField {
  label: string;
  value: ReactNode;
  /** Secondary browse/filter action kept outside editable values and links. */
  filterAction?: ReactNode;
  /** Quiet provenance beside the value; wraps within the value slot when needed. */
  caption?: ReactNode;
  hide?: boolean;
  /** Prose gets the full fact-grid width instead of a narrow value column. */
  fullWidth?: boolean;
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
      <Ledger as="dl" variant="facts">
        {visibleFields.map((field) => (
          <LedgerRow
            as="div"
            key={field.label}
            data-full-width={field.fullWidth}
          >
            <LedgerCell
              as="dt"
              slot="primary"
              data-slot="basic-info-label"
              className="text-muted-foreground"
            >
              {field.label}
            </LedgerCell>
            <LedgerCell as="dd" slot="secondary" data-slot="basic-info-value">
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 break-words [&>*]:max-w-full [&>*]:min-w-0">
                {field.value}
                {field.caption && (
                  <span className="min-w-0 text-xs text-muted-foreground">
                    {field.caption}
                  </span>
                )}
              </span>
            </LedgerCell>
            {field.filterAction && (
              <LedgerCell as="dd" slot="actions">
                {field.filterAction}
              </LedgerCell>
            )}
          </LedgerRow>
        ))}
      </Ledger>
      {footer}
      {actions && <div className="pt-2">{actions}</div>}
    </Stack>
  );
};
