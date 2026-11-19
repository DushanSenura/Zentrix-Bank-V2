-- Phase 1's trigger evaluated OLD.status for LedgerPosting rows (no such column), so postings were protected only
-- by an accidental "record old has no field status" error. Branch on the table first.
CREATE OR REPLACE FUNCTION ledger_forbid_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'LedgerJournal' AND TG_OP = 'UPDATE' THEN
    -- The only permitted change: POSTED -> REVERSED, nothing else altered.
    IF OLD.status = 'POSTED' AND NEW.status = 'REVERSED'
       AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'Ledger rows are append-only (% on %)', TG_OP, TG_TABLE_NAME;
END; $$ LANGUAGE plpgsql;
