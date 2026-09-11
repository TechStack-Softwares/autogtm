import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { sendInngestEvent, isInngestUnreachable, INNGEST_UNAVAILABLE_MESSAGE } from '@/inngest/client';

/**
 * Manually trigger the Autopilot sweep for a single company.
 * Fires `autogtm/auto-add.sweep-company` with trigger: 'manual'.
 * Respects the company's current preferences (limit, min_fit_score) — but
 * does NOT require `auto_add_enabled` to be true (useful for dry-run / first run).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: companyId } = await params;

    const supabase = createAdminClient();

    const { data: company, error } = await supabase
      .from('companies')
      .select('id')
      .eq('id', companyId)
      .single();

    if (error || !company) {
      return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    }

    const result = await sendInngestEvent({
      name: 'autogtm/auto-add.sweep-company',
      data: { companyId, trigger: 'manual' },
    });

    return NextResponse.json({ success: true, eventIds: result.ids });
  } catch (error) {
    console.error('Error triggering auto-add sweep:', error);
    if (isInngestUnreachable(error)) {
      return NextResponse.json({ error: INNGEST_UNAVAILABLE_MESSAGE }, { status: 503 });
    }
    return NextResponse.json(
      { error: 'Failed to trigger auto-add sweep' },
      { status: 500 }
    );
  }
}
