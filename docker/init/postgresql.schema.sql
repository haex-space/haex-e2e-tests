-- Post-init script to set passwords for Supabase roles
-- This is executed after database initialization by migrate.sh

-- Set password for supabase_auth_admin (used by GoTrue)
ALTER USER supabase_auth_admin WITH PASSWORD 'postgres';

-- Set password for supabase_storage_admin (used by Storage)
ALTER USER supabase_storage_admin WITH PASSWORD 'postgres';

-- Create _realtime schema (required by Supabase Realtime)
CREATE SCHEMA IF NOT EXISTS _realtime;
ALTER SCHEMA _realtime OWNER TO postgres;
