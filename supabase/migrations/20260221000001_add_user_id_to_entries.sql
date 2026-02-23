-- Add user_id column to entries table if it doesn't already exist
ALTER TABLE entries ADD COLUMN IF NOT EXISTS user_id text;

-- Create an index for faster per-user lookups
CREATE INDEX IF NOT EXISTS entries_user_id_idx ON entries (user_id);
