-- Review wire cutover. Only declared review-reference keys change, including
-- those inside saved answers and decision receipts; frozen input snapshots,
-- archive ledgers, publication keys and every other decision field remain exact.
LOCK TABLE "AiEvaluation", "Suggestion", "AiAnalysis" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
CREATE FUNCTION pg_temp.rename_review_reference(value jsonb, reverse boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE old_key text; new_key text; pair text[];
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN value; END IF;
  FOREACH pair SLICE 1 IN ARRAY ARRAY[
    ARRAY['assessmentId','suggestionId'],
    ARRAY['assessmentIds','suggestionIds'],
    ARRAY['targetAssessmentId','targetSuggestionId']
  ] LOOP
    old_key := pair[CASE WHEN reverse THEN 2 ELSE 1 END];
    new_key := pair[CASE WHEN reverse THEN 1 ELSE 2 END];
    IF value ? old_key THEN
      IF value ? new_key THEN RAISE EXCEPTION 'Conflicting review reference keys'; END IF;
      value := (value - old_key) || jsonb_build_object(new_key, value->old_key);
    END IF;
  END LOOP;
  RETURN value;
END $$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.rename_field_output(value jsonb, reverse boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE collection text; field record; output jsonb := pg_temp.rename_review_reference(value, reverse);
BEGIN
  IF jsonb_typeof(output) IS DISTINCT FROM 'object' THEN RETURN output; END IF;
  FOREACH collection IN ARRAY ARRAY['suggestions','outcomes'] LOOP
    IF jsonb_typeof(output->collection) = 'object' THEN
      FOR field IN SELECT entry.key, entry.value FROM jsonb_each(output->collection) AS entry LOOP
        output := jsonb_set(output, ARRAY[collection, field.key],
          pg_temp.rename_review_reference(field.value, reverse));
      END LOOP;
    END IF;
  END LOOP;
  RETURN output;
END $$;
--> statement-breakpoint
DO $$
DECLARE original record; changed jsonb; changed_result jsonb; changed_receipt jsonb; actual record;
BEGIN
  FOR original IN SELECT * FROM "AiEvaluation" LOOP
    changed := pg_temp.rename_review_reference(original.target);
    changed_result := original.result;
    IF jsonb_typeof(original.result->'output') = 'object' THEN
      changed_result := jsonb_set(original.result, '{output}', pg_temp.rename_field_output(original.result->'output'));
    END IF;
    changed_receipt := pg_temp.rename_review_reference(original.receipt);
    IF (changed IS DISTINCT FROM original.target AND pg_temp.rename_review_reference(changed, true) IS DISTINCT FROM original.target)
      OR (changed_result IS DISTINCT FROM original.result AND
        jsonb_set(changed_result, '{output}', pg_temp.rename_field_output(changed_result->'output', true)) IS DISTINCT FROM original.result)
      OR (changed_receipt IS DISTINCT FROM original.receipt AND pg_temp.rename_review_reference(changed_receipt, true) IS DISTINCT FROM original.receipt)
    THEN RAISE EXCEPTION 'AI evaluation reference preservation failed for %', original.id; END IF;
    IF changed IS DISTINCT FROM original.target OR changed_result IS DISTINCT FROM original.result OR changed_receipt IS DISTINCT FROM original.receipt THEN
      UPDATE "AiEvaluation" SET target=changed, result=changed_result, receipt=changed_receipt WHERE id=original.id;
      SELECT * INTO actual FROM "AiEvaluation" WHERE id=original.id;
      IF to_jsonb(actual) IS DISTINCT FROM (to_jsonb(original) || jsonb_build_object('target',changed,'result',changed_result,'receipt',changed_receipt))
      THEN RAISE EXCEPTION 'AI evaluation read-back failed for %', original.id; END IF;
    END IF;
  END LOOP;
  FOR original IN SELECT * FROM "Suggestion" WHERE family='field' LOOP
    changed := original.evidence;
    changed_result := original.judgment;
    IF jsonb_typeof(original.evidence->'proposal') = 'object' THEN
      changed := jsonb_set(original.evidence, '{proposal}', pg_temp.rename_review_reference(original.evidence->'proposal'));
    END IF;
    IF jsonb_typeof(original.judgment->'outcome') = 'object' THEN
      changed_result := jsonb_set(original.judgment, '{outcome}', pg_temp.rename_review_reference(original.judgment->'outcome'));
    END IF;
    IF (changed IS DISTINCT FROM original.evidence AND
        jsonb_set(changed, '{proposal}', pg_temp.rename_review_reference(changed->'proposal', true)) IS DISTINCT FROM original.evidence)
      OR (changed_result IS DISTINCT FROM original.judgment AND
        jsonb_set(changed_result, '{outcome}', pg_temp.rename_review_reference(changed_result->'outcome', true)) IS DISTINCT FROM original.judgment)
    THEN RAISE EXCEPTION 'Field publication reference preservation failed for %', original.id; END IF;
    IF changed IS DISTINCT FROM original.evidence OR changed_result IS DISTINCT FROM original.judgment THEN
      UPDATE "Suggestion" SET evidence=changed, judgment=changed_result WHERE id=original.id;
      SELECT * INTO actual FROM "Suggestion" WHERE id=original.id;
      IF to_jsonb(actual) IS DISTINCT FROM (to_jsonb(original) || jsonb_build_object('evidence',changed,'judgment',changed_result))
      THEN RAISE EXCEPTION 'Field publication read-back failed for %', original.id; END IF;
    END IF;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.rename_saved_answer(value jsonb, reverse boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE path text[];
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object' THEN RETURN value; END IF;
  FOREACH path SLICE 1 IN ARRAY ARRAY[ARRAY['outcome', ''], ARRAY['preview', 'outcome'], ARRAY['preview', 'suggestion']] LOOP
    IF path[2] = '' THEN
      IF jsonb_typeof(value->path[1]) = 'object' THEN
        value := jsonb_set(value, ARRAY[path[1]], pg_temp.rename_review_reference(value->path[1], reverse));
      END IF;
    ELSIF jsonb_typeof(value->path[1]->path[2]) = 'object' THEN
      value := jsonb_set(value, path, pg_temp.rename_review_reference(value->path[1]->path[2], reverse));
    END IF;
  END LOOP;
  RETURN value;
END $$;
--> statement-breakpoint
CREATE FUNCTION pg_temp.rename_decision_receipts(value jsonb, reverse boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql AS $$
  SELECT CASE WHEN jsonb_typeof(value) IS DISTINCT FROM 'array' THEN value ELSE coalesce((
    SELECT jsonb_agg(CASE WHEN jsonb_typeof(decision->'receipt') = 'object'
      THEN jsonb_set(decision, '{receipt}', pg_temp.rename_review_reference(decision->'receipt', reverse))
      ELSE decision END ORDER BY position)
    FROM jsonb_array_elements(value) WITH ORDINALITY AS item(decision, position)), '[]'::jsonb) END
$$;
--> statement-breakpoint
DO $$
DECLARE original record; changed jsonb; actual record;
BEGIN
  FOR original IN SELECT * FROM "AiAnalysis" WHERE result IS NOT NULL LOOP
    changed := pg_temp.rename_saved_answer(original.result);
    IF changed IS DISTINCT FROM original.result THEN
      IF pg_temp.rename_saved_answer(changed, true) IS DISTINCT FROM original.result
      THEN RAISE EXCEPTION 'Saved answer reference preservation failed for %', original.id; END IF;
      UPDATE "AiAnalysis" SET result=changed WHERE id=original.id;
      SELECT * INTO actual FROM "AiAnalysis" WHERE id=original.id;
      IF to_jsonb(actual) IS DISTINCT FROM (to_jsonb(original) || jsonb_build_object('result',changed))
      THEN RAISE EXCEPTION 'Saved answer read-back failed for %', original.id; END IF;
    END IF;
  END LOOP;
  FOR original IN SELECT * FROM "Suggestion" LOOP
    changed := pg_temp.rename_decision_receipts(original.decisions);
    IF changed IS DISTINCT FROM original.decisions THEN
      IF pg_temp.rename_decision_receipts(changed, true) IS DISTINCT FROM original.decisions
      THEN RAISE EXCEPTION 'Decision receipt preservation failed for %', original.id; END IF;
      UPDATE "Suggestion" SET decisions=changed WHERE id=original.id;
      SELECT * INTO actual FROM "Suggestion" WHERE id=original.id;
      IF to_jsonb(actual) IS DISTINCT FROM (to_jsonb(original) || jsonb_build_object('decisions',changed))
      THEN RAISE EXCEPTION 'Decision receipt read-back failed for %', original.id; END IF;
    END IF;
  END LOOP;
END $$;
