CREATE OR REPLACE FUNCTION derived_mark_importsourceorder() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@20', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@20', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[NEW."purchaseId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[OLD."purchaseId"::uuid]); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."sourceClaimId") IS DISTINCT FROM (NEW."purchaseId", NEW."sourceClaimId") THEN
    PERFORM derived_mark('expense.beneficiaryResult@7', ARRAY[OLD."purchaseId"::uuid] || ARRAY[NEW."purchaseId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(NEW."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(OLD."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF (true OR true) AND (OLD."purchaseId", OLD."sourceClaimId", OLD."checksum") IS DISTINCT FROM (NEW."purchaseId", NEW."sourceClaimId", NEW."checksum") THEN
    PERFORM derived_mark('email.relationshipFacts@9', ARRAY[coalesce(OLD."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."purchaseId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@9', ARRAY[NEW."sourceClaimId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@9', ARRAY[OLD."sourceClaimId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@9', ARRAY[OLD."sourceClaimId"::uuid] || ARRAY[NEW."sourceClaimId"::uuid]);
  END IF;
  RETURN NULL;
END $$;
