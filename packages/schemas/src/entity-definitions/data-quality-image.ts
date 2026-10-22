/** Every scored entity needs displayable media before it can earn 100. */
export const displayImageQualityCheck = (entity: string) => ({
  id: `${entity.toLowerCase()}_display_image`,
  facet: "provenance" as const,
  kind: "missing" as const,
  weight: 1,
  scoring: "unscored" as const,
  scoreCap: 99,
  exceptions: "forbidden" as const,
  satisfiedLabel: "Display image available",
  placement: null,
  label: "No display image",
  message:
    "No displayable image is available, directly or through related records.",
});
