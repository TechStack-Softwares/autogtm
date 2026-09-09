import { NextRequest, NextResponse } from 'next/server';
import { generateExaQueries } from '@autogtm/core/ai/generateQueries';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, website, description, targetAudience } = body;

    if (!name || !website || !description || !targetAudience) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    const queries = await generateExaQueries({
      companyName: name,
      companyWebsite: website,
      companyDescription: description,
      targetAudience: targetAudience,
      numberOfQueries: 5,
    });

    return NextResponse.json({ queries });
  } catch (error) {
    console.error('Error generating queries:', error);
    const message = error instanceof Error ? error.message : 'Failed to generate queries';
    const status = /insufficient_quota|credits remaining|429/.test(message) ? 402 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
