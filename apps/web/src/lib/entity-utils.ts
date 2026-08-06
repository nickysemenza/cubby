function hasProperty<K extends string>(
  obj: unknown,
  key: K,
): obj is Record<K, unknown> {
  return typeof obj === "object" && obj !== null && key in obj;
}

function isObjectWithName(value: unknown): value is { name: string } {
  return (
    hasProperty(value, "name") &&
    typeof value.name === "string" &&
    value.name.trim() !== ""
  );
}

export function extractEntityTitle<T>(rowData: T): string {
  if (
    hasProperty(rowData, "name") &&
    typeof rowData.name === "string" &&
    rowData.name.trim()
  ) {
    return rowData.name;
  }

  if (
    hasProperty(rowData, "filename") &&
    typeof rowData.filename === "string" &&
    rowData.filename.trim()
  ) {
    return rowData.filename;
  }

  if (
    hasProperty(rowData, "product") &&
    isObjectWithName(rowData.product) &&
    hasProperty(rowData, "location") &&
    isObjectWithName(rowData.location)
  ) {
    return `${rowData.product.name} @ ${rowData.location.name}`;
  }

  return "Unknown";
}
