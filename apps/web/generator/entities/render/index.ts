import type { ChildTableDeclaration } from "@cubby/schemas/compiler/entity-definitions/child-definition";
import type { CompiledEntity, EntityArtifacts } from "../declarations.ts";
import { renderFieldSchemaArtifacts } from "./field-schemas.ts";
import { renderFieldEnvelopeArtifacts } from "./field-envelopes.ts";
import { renderEntityMetadataArtifacts } from "./metadata.ts";
import { renderEntityDatabaseArtifacts } from "./database.ts";
import { renderEntityReadArtifacts } from "./read-contracts.ts";
import { renderEntitySchemaArtifacts } from "./schema-contracts.ts";
import { renderOptionGlyphs } from "./option-glyphs.ts";
import { renderFieldExplanationReference } from "./field-explanations-reference.ts";
import { renderStructuredValueSchemas } from "./structured-value-schemas.ts";
import { renderSwiftEntityCatalog } from "./swift-catalog.ts";
import { renderSwiftSharedConstants } from "./swift-shared-constants.ts";
import { renderDataQualityArtifacts } from "./data-quality.ts";
import { renderClassificationPolicyArtifacts } from "../classification-policies.ts";
import { renderImagePolicyArtifacts } from "./image-policy.ts";
import { renderCoverageTotalsArtifacts } from "./coverage-totals.ts";
import { renderSchemaWrapperArtifacts } from "./schema-wrappers.ts";

export {
  kernelHttpActionsFor,
  entityOutputsFor,
  type KernelActions,
} from "./capabilities.ts";

/** One compiled declaration spine, projected by each artifact's owner. */
export const renderEntityArtifacts = (
  entities: readonly CompiledEntity[],
  moduleChildren: readonly ChildTableDeclaration[] = [],
): EntityArtifacts[] => [
  ...renderDataQualityArtifacts(entities),
  ...renderClassificationPolicyArtifacts(entities),
  ...renderSchemaWrapperArtifacts(entities),
  ...renderCoverageTotalsArtifacts(entities),
  ...renderImagePolicyArtifacts(entities),
  ...renderFieldExplanationReference(entities),
  ...renderEntityMetadataArtifacts(entities),
  ...renderEntityDatabaseArtifacts(entities, moduleChildren),
  ...renderFieldSchemaArtifacts(entities),
  ...renderFieldEnvelopeArtifacts(entities),
  ...renderEntityReadArtifacts(entities),
  ...renderEntitySchemaArtifacts(entities),
  renderOptionGlyphs(entities),
  ...renderSwiftEntityCatalog(entities),
  ...renderStructuredValueSchemas(entities),
  ...renderSwiftSharedConstants(),
];
