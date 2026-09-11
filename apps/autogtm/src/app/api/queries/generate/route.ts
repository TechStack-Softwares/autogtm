import { NextRequest, NextResponse } from 'next/server';
import { sendInngestEvent, isInngestUnreachable, INNGEST_UNAVAILABLE_MESSAGE } from '@/inngest/client';

export async function POST(request: NextRequest) {
  try {
    const { companyId, instructionId } = await request.json();

    if (!companyId) {
      return NextResponse.json({ error: 'companyId is required' }, { status: 400 });
    }

    if (instructionId) {
      await sendInngestEvent({
        name: 'autogtm/queries.generate-for-instruction',
        data: { companyId, instructionId },
      });
      return NextResponse.json({ success: true, message: 'Instruction-specific query generation started' });
    }

    await sendInngestEvent({
      name: 'autogtm/queries.generate',
      data: { companyId },
    });

    return NextResponse.json({ success: true, message: 'Query generation started' });
  } catch (error) {
    console.error('Error triggering query generation:', error);
    if (isInngestUnreachable(error)) {
      return NextResponse.json({ error: INNGEST_UNAVAILABLE_MESSAGE }, { status: 503 });
    }
    return NextResponse.json({ error: 'Failed to trigger query generation' }, { status: 500 });
  }
}
