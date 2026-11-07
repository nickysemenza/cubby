CREATE OR REPLACE FUNCTION derived_mark_importsourceclaim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@19', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@37', ARRAY[NEW."ledgerPartyId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('purchase.dataQuality@37', ARRAY[OLD."ledgerPartyId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@37', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@10', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('expense.beneficiaryResult@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."id", NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('expense.beneficiaryResult@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@10', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF (true OR true) AND (OLD."id", OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."id", NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('email.relationshipFacts@10', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@11', ARRAY[coalesce(NEW."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.relationshipFacts@11', ARRAY[coalesce(OLD."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]); END IF;
  ELSIF (true OR true) AND (OLD."canonicalClaimId", OLD."ledgerPartyId", OLD."kind", OLD."externalKey") IS DISTINCT FROM (NEW."canonicalClaimId", NEW."ledgerPartyId", NEW."kind", NEW."externalKey") THEN
    PERFORM derived_mark('email.relationshipFacts@11', ARRAY[coalesce(OLD."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."canonicalClaimId"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)]);
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@7', ARRAY[NEW."ledgerPartyId"::uuid]); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@7', ARRAY[OLD."ledgerPartyId"::uuid]); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@7', ARRAY[OLD."ledgerPartyId"::uuid] || ARRAY[NEW."ledgerPartyId"::uuid]);
  END IF;
  RETURN NULL;
END $$;
