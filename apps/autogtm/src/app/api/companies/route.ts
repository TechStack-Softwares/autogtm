import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: NextRequest) {
  try {
    const supabase = createAdminClient();

    const { data: companies, error } = await supabase
      .from('companies')
      .select('id, name, system_enabled')
      .order('created_at', { ascending: false });

    if (error) throw error;

    return NextResponse.json({ companies: companies || [] });
  } catch (error) {
    console.error('Error fetching companies:', error);
    return NextResponse.json(
      { error: 'Failed to fetch companies' },
      { status: 500 }
    );
  }
}
