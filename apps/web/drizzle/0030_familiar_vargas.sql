-- Custom SQL migration file, put your code below! --
UPDATE "Run"
SET
  input = (input - 'field') || jsonb_build_object('fields', jsonb_build_array(input ->> 'field')),
  progress = CASE
    WHEN jsonb_typeof(progress -> 'processedTargetIds') = 'array' THEN
      jsonb_set(
        progress,
        '{processedTargetIds}',
        COALESCE(
          (
            SELECT jsonb_agg(to_jsonb(target_id || ':' || (input ->> 'field')))
            FROM jsonb_array_elements_text(progress -> 'processedTargetIds') AS targets(target_id)
          ),
          '[]'::jsonb
        )
      )
    ELSE progress
  END
WHERE purpose = 'suggestion_sweep'
  AND jsonb_typeof(input -> 'field') = 'string';
