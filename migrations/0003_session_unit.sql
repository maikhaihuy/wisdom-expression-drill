-- Unit scope of a drill session: NULL = all units (and every batch session).
ALTER TABLE sessions ADD COLUMN unit INTEGER;
