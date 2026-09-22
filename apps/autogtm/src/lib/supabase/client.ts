'use client';

import { createBrowserClient } from '@supabase/ssr';

/** Browser client — only for hash-based recovery tokens that never reach the server. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
  );
}
