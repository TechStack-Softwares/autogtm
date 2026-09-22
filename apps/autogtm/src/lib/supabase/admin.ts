import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseUrl } from '@/lib/supabase/env';

function getSupabaseServiceKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!key) {
    throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY');
  }
  return key;
}

let adminClient: SupabaseClient | null = null;

/** Service-role client for server-only Data API access. Singleton; no Auth session. */
export function createAdminClient(): SupabaseClient {
  if (adminClient) return adminClient;

  adminClient = createClient(getSupabaseUrl(), getSupabaseServiceKey(), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  return adminClient;
}
