CREATE INDEX IF NOT EXISTS "AssessmentState_statement_charge_history_idx" ON "AssessmentState" ((data->>'source'),(data->>'chargeKey'),"createdAt" DESC,id DESC) WHERE family='statement_transaction';
