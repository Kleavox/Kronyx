ALTER TABLE nodes ADD COLUMN hostname TEXT;

UPDATE nodes
SET hostname = name
WHERE enrolled_at IS NOT NULL AND hostname IS NULL;
