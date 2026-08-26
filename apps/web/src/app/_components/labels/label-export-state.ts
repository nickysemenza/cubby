export function canExportLabels({
  error,
  itemCount,
  qrReady,
  sheetFormat,
}: {
  error: unknown;
  itemCount: number;
  qrReady: boolean;
  sheetFormat: boolean;
}) {
  if (error || itemCount === 0) return false;
  return sheetFormat ? qrReady : true;
}

export function shouldMountLabelPrintPortal({
  error,
  isLoading,
  sheetFormat,
}: {
  error: unknown;
  isLoading: boolean;
  sheetFormat: boolean;
}) {
  return sheetFormat && !isLoading && !error;
}
