import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const companyId = searchParams.get('company_id');

    const supabase = createAdminClient();

    let query = supabase
      .from('exa_queries')
      .select('*, company_updates(content), webset_runs(webset_id, status)')
      .order('created_at', { ascending: false });

    if (companyId) {
      query = query.eq('company_id', companyId);
    }

    const { data: queries, error } = await query;

    if (error) throw error;

    return NextResponse.json({ queries: queries || [] });
  } catch (error) {
    console.error('Error fetching queries:', error);
    return NextResponse.json(
      { error: 'Failed to fetch queries' },
      { status: 500 }
    );
  }
}
