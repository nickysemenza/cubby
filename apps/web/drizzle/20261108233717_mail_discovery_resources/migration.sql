ALTER TABLE "MailboxCursor" ADD COLUMN "providerRetryAt" timestamp;--> statement-breakpoint
ALTER TABLE "MailboxCursor" ADD COLUMN "admissionVersion" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP INDEX "Run_one_active_mail_discovery";--> statement-breakpoint
CREATE UNIQUE INDEX "Run_one_active_mail_discovery" ON "Run" ("ledgerPartyId",COALESCE("input"->>'mailboxId', ''),md5(COALESCE(CASE WHEN "progress"->'discoveryScope'->>'kind' = 'query' THEN "progress"->'discoveryScope'->>'key' END, ''))) WHERE "purpose" = 'mail_discovery' AND "status" = 'running';
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cubby_guard_mail_discovery_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  mailbox text;
  resource text;
  old_resource text;
  waiting boolean;
  active_count integer;
  resource_busy boolean;
BEGIN
  waiting := coalesce(NEW.status = 'paused' AND NEW."failureCode" IN ('mail_discovery_queued', 'controlled_mail_queued'), false);
  IF NEW.purpose <> 'mail_discovery' OR (NEW.status <> 'running' AND NOT waiting) THEN RETURN NEW; END IF;
  mailbox := NEW.input->>'mailboxId';
  IF NEW."ledgerPartyId" IS NULL OR mailbox IS NULL OR mailbox = '' THEN
    RAISE EXCEPTION 'Mail discovery requires a member and stable mailbox';
  END IF;
  resource := CASE WHEN NEW.input->'controlled' IS NULL AND NEW.progress->'discoveryScope'->>'kind' = 'query'
    THEN NULLIF(NEW.progress->'discoveryScope'->>'key', '') END;
  IF TG_OP = 'UPDATE' THEN
    old_resource := CASE WHEN OLD.input->'controlled' IS NULL AND OLD.progress->'discoveryScope'->>'kind' = 'query'
      THEN NULLIF(OLD.progress->'discoveryScope'->>'key', '') END;
    IF OLD.purpose = NEW.purpose AND OLD.status = NEW.status
      AND OLD."ledgerPartyId" = NEW."ledgerPartyId" AND OLD.input->>'mailboxId' = mailbox
      AND old_resource IS NOT DISTINCT FROM resource
      AND (NOT waiting OR (OLD."failureCode" = NEW."failureCode"
        AND OLD.progress->>'attempt' IS NOT DISTINCT FROM NEW.progress->>'attempt'
        AND OLD.progress->>'admissionRequestedAt' IS NOT DISTINCT FROM NEW.progress->>'admissionRequestedAt'))
    THEN RETURN NEW; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cubby-mail-discovery:' || NEW."ledgerPartyId"::text || ':' || mailbox, 0));
  -- A changed row version refuses an admission made from an older snapshot.
  -- This write follows the Run lock, matching coverage publication's order.
  INSERT INTO "MailboxCursor" ("ledgerPartyId", provider, "mailboxId", "admissionVersion")
    VALUES (NEW."ledgerPartyId", 'gmail', mailbox, 1)
    ON CONFLICT ("ledgerPartyId", provider, "mailboxId") DO UPDATE
    SET "admissionVersion" = "MailboxCursor"."admissionVersion" + 1;
  IF waiting THEN RETURN NEW; END IF;
  -- includes-deleted: an active legacy writer still occupies capacity until it stops.
  SELECT count(*), coalesce(bool_or(resource IS NULL OR r.input->'controlled' IS NOT NULL OR r.progress->'discoveryScope'->>'kind' IS DISTINCT FROM 'query'
        OR NULLIF(r.progress->'discoveryScope'->>'key', '') IS NULL
        OR r.progress->'discoveryScope'->>'key' = resource), false)
    INTO active_count, resource_busy FROM "Run" r
    WHERE r.id <> NEW.id AND r.purpose = 'mail_discovery' AND r.status = 'running'
      AND r."ledgerPartyId" = NEW."ledgerPartyId" AND r.input->>'mailboxId' = mailbox;
  IF active_count >= 4 OR resource_busy THEN
    RAISE EXCEPTION USING ERRCODE = '23505', CONSTRAINT = 'Run_one_active_mail_discovery',
      MESSAGE = 'Mail discovery admission is occupied';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "Run_guard_mail_discovery_admission"
BEFORE INSERT OR UPDATE OF purpose, status, "ledgerPartyId", input, progress, "failureCode" ON "Run"
FOR EACH ROW EXECUTE FUNCTION cubby_guard_mail_discovery_admission();
