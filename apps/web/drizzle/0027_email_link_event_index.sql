-- Every reviewed decision of an order event, joined per Email row by the
-- link-state rank: the text key and the linked-only UUID index cannot serve it.
CREATE INDEX IF NOT EXISTS "AssessmentState_email_event_uuid_idx" ON "AssessmentState" (((data->>'eventId')::uuid)) WHERE family='email_link' AND active;
