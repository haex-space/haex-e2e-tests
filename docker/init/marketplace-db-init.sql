-- Marketplace database initialization script
-- Sets passwords for Supabase roles and creates storage bucket

-- Set password for supabase_auth_admin (used by GoTrue)
ALTER USER supabase_auth_admin WITH PASSWORD 'postgres';

-- Set password for supabase_storage_admin (used by Storage API)
ALTER USER supabase_storage_admin WITH PASSWORD 'postgres';

-- Set password for authenticator (used by PostgREST)
ALTER USER authenticator WITH PASSWORD 'postgres';

-- Create storage bucket for extension bundles (if storage schema exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
    -- Create the extensions bucket if it doesn't exist
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'extensions',
      'extensions',
      true,
      52428800, -- 50MB limit
      ARRAY['application/zip', 'application/octet-stream']::text[]
    )
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;
