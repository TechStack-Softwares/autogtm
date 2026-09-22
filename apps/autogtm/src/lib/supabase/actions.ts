'use server';

import { createClient } from '@/lib/supabase/server';

export async function signIn(
  email: string,
  password: string
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };
  return { success: true };
}

export async function signUp(
  email: string,
  password: string
): Promise<{ error?: string; alreadyExists?: boolean; success?: boolean }> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { user_type: 'autogtm' } },
  });
  if (error) return { error: error.message };
  if (data?.user?.identities?.length === 0) {
    return { alreadyExists: true };
  }
  return { success: true };
}

export async function resetPassword(
  email: string
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const origin = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3200';
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/login`,
  });
  if (error) return { error: error.message };
  return { success: true };
}

export async function updatePassword(
  newPassword: string
): Promise<{ error?: string; success?: boolean }> {
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) return { error: error.message };
  return { success: true };
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
}
