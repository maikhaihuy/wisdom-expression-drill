DROP INDEX IF EXISTS idx_expr_week;
ALTER TABLE expressions ADD COLUMN unit INTEGER NOT NULL DEFAULT 0;     -- 0 = not yet synced as a unit
ALTER TABLE expressions ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE expressions DROP COLUMN added_week;
CREATE INDEX idx_expr_unit ON expressions(unit, archived);
CREATE INDEX idx_expr_course ON expressions(archived, unit, position);
