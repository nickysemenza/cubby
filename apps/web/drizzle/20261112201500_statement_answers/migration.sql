UPDATE "Suggestion" SET data = data - 'labelCheckpoint'
WHERE family = 'statement_transaction' AND data ? 'labelCheckpoint';
