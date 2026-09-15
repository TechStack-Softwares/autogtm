import { discoverLeads, formatExaError } from '@autogtm/core/clients/exa';
import { sendInngestEvent } from '@/inngest/client';
import { ingestSearchHits } from './ingestSearchHits';

export { formatExaError };

export async function startQueryRun(supabase: any, queryId: string): Promise<{
  websetId: string;
  status: 'running' | 'completed';
  message: string;
  mode: 'webset' | 'search';
  leadsCreated?: number;
}> {
  const { data: query, error: queryError } = await supabase
    .from('exa_queries')
    .select('*')
    .eq('id', queryId)
    .single();

  if (queryError || !query) {
    throw new Error('Query not found');
  }

  await supabase
    .from('exa_queries')
    .update({ status: 'running' })
    .eq('id', queryId);

  let discovery;
  try {
    discovery = await discoverLeads({
      query: query.query,
      count: 25,
      criteria: query.criteria,
      enrichments: [
        { description: 'Find the email address for this person or creator', format: 'email' },
        { description: 'Extract the follower or subscriber count if visible', format: 'number' },
      ],
    });
  } catch (error) {
    await supabase.from('exa_queries').update({ status: 'failed' }).eq('id', queryId);
    throw new Error(formatExaError(error));
  }

  if (discovery.mode === 'search') {
    const ingested = await ingestSearchHits({
      supabase,
      queryId,
      companyId: query.company_id,
      hits: discovery.hits,
      sendLeadEvents: (events) => sendInngestEvent(events),
    });
    return {
      websetId: ingested.websetId,
      status: 'completed',
      mode: 'search',
      leadsCreated: ingested.leadsCreated,
      message: `Websets is not on this Exa plan; used regular search instead. Found ${ingested.itemsFound} pages, created ${ingested.leadsCreated} leads.`,
    };
  }

  const { data: websetRun, error: runError } = await supabase
    .from('webset_runs')
    .insert({
      query_id: queryId,
      webset_id: discovery.websetId,
      status: 'running',
      items_found: 0,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (runError) {
    console.error('Error creating webset run:', runError);
  }

  await sendInngestEvent({
    name: 'autogtm/webset.created',
    data: {
      queryId,
      websetId: discovery.websetId,
      websetRunId: websetRun?.id,
    },
  });

  return {
    websetId: discovery.websetId,
    status: 'running',
    mode: 'webset',
    message: 'Search started. Lead extraction will happen in background.',
  };
}
