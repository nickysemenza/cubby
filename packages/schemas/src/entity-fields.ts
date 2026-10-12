import { generatedEntityFieldModels } from "./generated/entity-field-model.gen";

export {
  generatedEntityFieldModels as entityFieldModels,
  suggestFieldKeys,
  type GeneratedEntityFieldModel as EntityFieldModel,
  type GeneratedEntityFieldKind as EntityFieldKind,
  type GeneratedEntityFieldControlKind as EntityFieldControlKind,
  type GeneratedEntityFieldProvenance as EntityFieldProvenance,
  type GeneratedSuggestFieldKey,
} from "./generated/entity-field-model.gen";

type FieldModelEntity = keyof typeof generatedEntityFieldModels;
type AnyEntityField =
  (typeof generatedEntityFieldModels)[FieldModelEntity]["fields"][number];

/** One manifest field by entity and key, for callers holding plain strings. */
export function entityFieldByKey(
  entity: FieldModelEntity,
  key: string,
): AnyEntityField | undefined {
  const fields: readonly AnyEntityField[] =
    generatedEntityFieldModels[entity].fields;
  return fields.find((field) => field.key === key);
}
