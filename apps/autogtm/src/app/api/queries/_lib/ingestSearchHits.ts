import { newSearchFallbackId, type ExaSearchHit } from '@autogtm/core/clients/exa';

function detectPlatform(url: string): string {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('tiktok.com')) return 'tiktok';
  if (urlLower.includes('instagram.com')) return 'instagram';
  if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) return 'youtube';
  if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) return 'twitter';
  if (urlLower.includes('linkedin.com')) return 'linkedin';
  return 'other';
}

export type IngestSearchResult = {
  websetRunId: string | null;
  websetId: string;
  itemsFound: number;
  leadsCreated: number;
  insertedLeads: Array<{ id: string; url: string; email: string | null; name: string | null }>;
};

/**
 * Persist regular Exa /search hits as leads and fire enrichment events.
 * Used when Websets is not available on the current Exa plan.
 */
export async function ingestSearchHits(params: {
  supabase: any;
  queryId: string;
  companyId: string;
  hits: ExaSearchHit[];
  sendLeadEvents: (events: Array<{
    name: 'autogtm/lead.created';
    data: { leadId: string; leadUrl: string; leadEmail: string | null; leadName: string | null; companyId: string };
  }>) => Promise<unknown>;
}): Promise<IngestSearchResult> {
  const { supabase, queryId, companyId, hits, sendLeadEvents } = params;
  const websetId = newSearchFallbackId();

  const { data: websetRun, error: runError } = await supabase
    .from('webset_runs')
    .insert({
      query_id: queryId,
      webset_id: websetId,
      status: 'running',
      items_found: hits.length,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (runError) throw runError;

  const urls = hits.map((h) => h.url);
  const { data: existingRows } = urls.length > 0
    ? await supabase.from('leads').select('url').in('url', urls)
    : { data: [] };
  const existingUrls = new Set((existingRows || []).map((r: { url: string }) => r.url));

  const leads = [];
  for (const hit of hits) {
    if (existingUrls.has(hit.url)) continue;
    existingUrls.add(hit.url);
    leads.push({
      query_id: queryId,
      webset_run_id: websetRun?.id ?? null,
      name: hit.title || hit.author || 'Unknown',
      email: null,
      url: hit.url,
      platform: detectPlatform(hit.url),
      follower_count: null,
      enrichment_data: hit,
      enrichment_status: 'pending' as const,
      campaign_status: 'pending' as const,
    });
  }

  let insertedLeads: IngestSearchResult['insertedLeads'] = [];
  if (leads.length > 0) {
    const { data: inserted, error } = await supabase
      .from('leads')
      .insert(leads)
      .select('id, url, email, name');
    if (error) throw error;
    insertedLeads = inserted || [];
  }

  await supabase
    .from('webset_runs')
    .update({
      status: 'completed',
      items_found: hits.length,
      completed_at: new Date().toISOString(),
    })
    .eq('id', websetRun.id);

  await supabase
    .from('exa_queries')
    .update({
      status: 'completed',
      last_run_at: new Date().toISOString(),
    })
    .eq('id', queryId);

  if (insertedLeads.length > 0 && companyId) {
    await sendLeadEvents(insertedLeads.map((lead) => ({
      name: 'autogtm/lead.created' as const,
      data: {
        leadId: lead.id,
        leadUrl: lead.url,
        leadEmail: lead.email,
        leadName: lead.name,
        companyId,
      },
    })));
  }

  return {
    websetRunId: websetRun?.id ?? null,
    websetId,
    itemsFound: hits.length,
    leadsCreated: insertedLeads.length,
    insertedLeads,
  };
}
