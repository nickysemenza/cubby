/** Every scored entity needs displayable media before it can earn 100. */
export const displayImageQualityCheck = (entity: string) => ({
  id: `${entity.toLowerCase()}_display_image`,
  facet: "provenance" as const,
  kind: "missing" as const,
  scoring: "unscored" as const,
  exceptions: "forbidden" as const,
  satisfiedLabel: "Display image available",
  placement: { section: "images" },
  label: "No display image",
  message:
    "No displayable image is available, directly or through related records.",
});
