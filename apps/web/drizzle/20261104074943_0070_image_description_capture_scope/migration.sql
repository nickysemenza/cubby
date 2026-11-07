-- Narrow future image-description invalidations; preserve all retained work.
CREATE OR REPLACE FUNCTION derived_mark_feedback() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('product.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('product.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('recipe.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('recipe.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('ingredient.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('ingredient.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('cookbook.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('cookbook.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('location.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('location.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('inventory.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('inventory.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('meal.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('meal.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Feedback removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@11', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('project.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('project.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('task.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('task.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('vendor.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('vendor.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('purchase.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('purchase.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialAccount.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialAccount.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialTransaction.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('financialTransaction.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('wish.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('wish.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('expense.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('expense.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('image.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('image.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('planting.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('planting.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('gardenEntry.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('gardenEntry.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('plant.searchDocument@6', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' THEN PERFORM derived_mark('plant.searchDocument@6', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (OLD."authority" = 'automatic' AND OLD."intent" = 'history' AND OLD."actorUserId" = 'cubby-system' OR NEW."authority" = 'automatic' AND NEW."intent" = 'history' AND NEW."actorUserId" = 'cubby-system') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@6', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@14', ARRAY[NEW."assessmentId"::uuid], 'Feedback created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('email.dataQuality@14', ARRAY[OLD."assessmentId"::uuid], 'Feedback removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@14', ARRAY[OLD."assessmentId"::uuid] || ARRAY[NEW."assessmentId"::uuid], 'Feedback changed');
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION derived_mark_assessmentstate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('product.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('product.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('recipe.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('recipe.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('ingredient.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('cookbook.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('location.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('location.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('inventory.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('inventory.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('meal.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('meal.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF true THEN PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment state removed'); END IF;
  ELSIF (true OR true) AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.workDiagnosticFacts@2', ARRAY[coalesce(OLD."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)] || ARRAY[coalesce(NEW."id"::uuid, '00000000-0000-4000-8000-000000000000'::uuid)], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('project.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('project.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('task.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('task.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('vendor.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('vendor.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('purchase.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'email_link' THEN PERFORM derived_mark('purchase.dataQuality@11', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'email_link' THEN PERFORM derived_mark('purchase.dataQuality@11', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'email_link' OR NEW."family" = 'email_link') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality@11', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."entity" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."entity" = 'purchase' THEN PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."entity" = 'purchase' OR NEW."entity" = 'purchase') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('purchase.dataQuality', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialAccount.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('financialTransaction.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('wish.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('wish.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'email_link' THEN PERFORM derived_mark('expense.beneficiaryResult@8', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'email_link' THEN PERFORM derived_mark('expense.beneficiaryResult@8', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'email_link' OR NEW."family" = 'email_link') AND (OLD."data", OLD."active", OLD."family") IS DISTINCT FROM (NEW."data", NEW."active", NEW."family") THEN
    PERFORM derived_mark('expense.beneficiaryResult@8', ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'purchaseId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'purchaseId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('expense.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('expense.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('image.searchDocument', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('image.searchDocument', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('planting.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('planting.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('gardenEntry.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@4', ARRAY[NEW."recordId"::uuid], 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'image_description' THEN PERFORM derived_mark('plant.searchDocument@4', ARRAY[OLD."recordId"::uuid], 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'image_description' OR NEW."family" = 'image_description') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('plant.searchDocument@4', ARRAY[OLD."recordId"::uuid] || ARRAY[NEW."recordId"::uuid], 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'email_link' THEN PERFORM derived_mark('email.relationshipFacts@4', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'email_link' THEN PERFORM derived_mark('email.relationshipFacts@4', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'email_link' OR NEW."family" = 'email_link') AND (OLD."data", OLD."active", OLD."family") IS DISTINCT FROM (NEW."data", NEW."active", NEW."family") THEN
    PERFORM derived_mark('email.relationshipFacts@4', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state changed');
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."family" = 'email_link' THEN PERFORM derived_mark('email.dataQuality@6', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state created'); END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD."family" = 'email_link' THEN PERFORM derived_mark('email.dataQuality@6', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state removed'); END IF;
  ELSIF (OLD."family" = 'email_link' OR NEW."family" = 'email_link') AND (to_jsonb(OLD) - ARRAY['updatedAt']) IS DISTINCT FROM (to_jsonb(NEW) - ARRAY['updatedAt']) THEN
    PERFORM derived_mark('email.dataQuality@6', ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(OLD."data")) = 'array' THEN jsonb_build_array(OLD."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') || ARRAY(SELECT (e->>'eventId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(jsonb_build_array(NEW."data")) = 'array' THEN jsonb_build_array(NEW."data") ELSE '[]'::jsonb END) AS e WHERE e->>'eventId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'), 'Assessment state changed');
  END IF;
  RETURN NULL;
END $$;
