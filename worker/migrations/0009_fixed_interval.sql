UPDATE nodes SET interval_seconds = 60 WHERE interval_seconds <> 60;
UPDATE enrollment_tokens SET interval_seconds = 60 WHERE interval_seconds <> 60;
