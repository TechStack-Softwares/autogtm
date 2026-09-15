import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { startQueryRun } from '../../_lib/startQueryRun';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: queryId } = await params;

    const supabase = createAdminClient();

    const result = await startQueryRun(supabase, queryId);

    return NextResponse.json({
      success: true,
      websetId: result.websetId,
      status: result.status,
      message: result.message,
      mode: result.mode,
      leadsCreated: result.leadsCreated ?? 0,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Query not found') {
      return NextResponse.json({ error: 'Query not found' }, { status: 404 });
    }
    console.error('Error running query:', error);
    const message = error instanceof Error ? error.message : 'Failed to run query';
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
