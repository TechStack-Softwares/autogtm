import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Returns the most recent Autopilot sweep runs for a company, used to power
 * the "Last run" summary + history view in the Autopilot settings panel.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: companyId } = await params;
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || '10', 10) || 10, 1), 50);

    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from('auto_add_runs')
      .select()
      .eq('company_id', companyId)
      .order('run_started_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    return NextResponse.json({ runs: data || [] });
  } catch (error) {
    console.error('Error fetching auto-add runs:', error);
    return NextResponse.json(
      { error: 'Failed to fetch auto-add runs' },
      { status: 500 }
    );
  }
}
