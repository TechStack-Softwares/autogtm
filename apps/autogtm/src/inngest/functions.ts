import { inngest } from './client';
import { getExaClient, discoverLeads, formatExaError } from '@autogtm/core/clients/exa';
import { ingestSearchHits } from '@/app/api/queries/_lib/ingestSearchHits';
import { enrichLead } from '@autogtm/core/ai/enrichLead';
import {
  getCampaign,
  getCampaignAnalytics,
} from '@autogtm/core/clients/instantly';
import {
  updateCampaignStats,
  createDailyDigest,
  markLeadSkipped,
  setSuggestedCampaign,
  getCampaignBySourceLeadId,
  listAutoEnabledCompanies,
  getEligibleLeadsForAutoAdd,
  countReadyToAddLeads,
  countLeadsAddedToday,
  createAutoAddRun,
  completeAutoAddRun,
} from '@autogtm/core/db/autogtmDbCalls';
import { determineCampaignForLead } from '@autogtm/core/ai/determineCampaign';
import { createDraftCampaignForLead } from '@autogtm/core/campaigns/createCampaignForPersona';
import { addLeadToCampaignCore, type AddLeadToCampaignResult } from '@autogtm/core/campaigns/addLeadToCampaign';
import { normalizeLeadCategory, type AutoAddRunBreakdownEntry } from '@autogtm/core/types';
import { extractEmailFromEnrichmentData } from '@autogtm/core/ai/extractEmail';
import { resolveOutreachPromptForLead } from '@/lib/outreachPromptResolver';
import { Resend } from 'resend';
import { createAdminClient } from '@/lib/supabase/admin';

const getResend = () => new Resend(process.env.RESEND_API_KEY);

const getSupabase = () => createAdminClient();

function mapInstantlyCampaignStatus(status: number): 'draft' | 'active' | 'paused' | 'completed' {
  // Instantly status codes: 0=draft, 1=active, 2=paused, 3=completed, 4=sub-sequences running.
  if (status === 0) return 'draft';
  if (status === 1 || status === 4) return 'active';
  if (status === 2) return 'paused';
  if (status === 3) return 'completed';
  // Unknown/negative statuses are treated as paused locally to avoid invalid DB values.
  return 'paused';
}

/** Check if system is enabled for a company. Returns false if disabled. */
async function isSystemEnabled(supabase: any, companyId: string): Promise<boolean> {
  const { data } = await supabase.from('companies').select('system_enabled').eq('id', companyId).single();
  return data?.system_enabled === true;
}

/** Max Exa webset runs per company per UTC day. Caps spend without blocking the hourly pipeline. */
const WEBSETS_PER_COMPANY_PER_DAY = 3;

function utcDayStartIso(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
}

async function countWebsetRunsToday(supabase: any, companyId: string): Promise<number> {
  const { data: queries } = await supabase.from('exa_queries').select('id').eq('company_id', companyId);
  const ids = (queries || []).map((q: { id: string }) => q.id);
  if (ids.length === 0) return 0;
  const { count } = await supabase
    .from('webset_runs')
    .select('id', { count: 'exact', head: true })
    .in('query_id', ids)
    .gte('started_at', utcDayStartIso());
  return count || 0;
}

async function hasExplorationQueryToday(supabase: any, companyId: string): Promise<boolean> {
  const { data } = await supabase
    .from('exa_queries')
    .select('id')
    .eq('company_id', companyId)
    .is('source_instruction_id', null)
    .gte('created_at', utcDayStartIso())
    .limit(1)
    .maybeSingle();
  return !!data?.id;
}

/**
 * Extract email from Exa enrichment data (handles multiple formats)
 */
function extractEmailFromEnrichments(enrichments: any): string | null {
  if (!enrichments) return null;

  // Direct email field
  if (typeof enrichments.email === 'string') return enrichments.email;

  // Array of enrichment objects (Exa webset format)
  if (Array.isArray(enrichments)) {
    for (const e of enrichments) {
      if (e?.format === 'email' && Array.isArray(e?.result) && e.result.length > 0) {
        return e.result[0];
      }
    }
  }

  // Named enrichment fields
  const emailKeys = ['Find the email address for this person or creator', 'email_address', 'contact_email'];
  for (const key of emailKeys) {
    const val = enrichments[key];
    if (typeof val === 'string') return val;
    if (val?.value && typeof val.value === 'string') return val.value;
    if (Array.isArray(val?.result) && val.result.length > 0) return val.result[0];
  }

  return null;
}

/**
 * Process Webset Run - Polls webset status and extracts leads when done
 * Triggered when a query is run manually
 */
export const processWebsetRun = inngest.createFunction(
  {
    id: 'process-webset-run',
    name: 'Process Webset Run',
    retries: 3,
    concurrency: [
      { key: 'event.data.websetId', limit: 1 },
      { limit: 5 },
    ],
    throttle: { limit: 8, period: '1m' },
  },
  { event: 'autogtm/webset.created' },
  async ({ event, step, logger }) => {
    const { queryId, websetId, websetRunId } = event.data;
    const exa = getExaClient();
    const supabase = getSupabase();

    const alreadyDone = await step.run('check-already-complete', async () => {
      if (!websetRunId) return false;
      const { data } = await supabase.from('webset_runs').select('status').eq('id', websetRunId).single();
      return data?.status === 'completed';
    });
    if (alreadyDone) {
      logger.info(`Webset run ${websetRunId} already completed, skipping`);
      return { skipped: true, reason: 'already_completed' };
    }

    logger.info(`Processing webset ${websetId} for query ${queryId}`);

    // Poll until webset is done
    let websetStatus = 'running';
    let attempts = 0;
    const pollIntervalSeconds = 10;
    const maxAttempts = 540; // 90 minutes max (540 * 10 seconds)

    while (websetStatus !== 'idle' && attempts < maxAttempts) {
      await step.sleep(`wait-${attempts}`, `${pollIntervalSeconds}s`);
      attempts++;

      const webset = await step.run(`check-status-${attempts}`, async () => {
        return exa.websets.get(websetId);
      });

      websetStatus = webset.status;
      logger.info(`Webset ${websetId} status: ${websetStatus} (attempt ${attempts})`);

      // Update progress in DB
      const search = webset.searches?.[0];
      const progress = search?.progress;
      if (progress) {
        await supabase
          .from('webset_runs')
          .update({ items_found: progress.found || 0 })
          .eq('id', websetRunId);
      }
    }

    if (websetStatus !== 'idle') {
      // Timed out
      await supabase.from('webset_runs').update({ status: 'failed' }).eq('id', websetRunId);
      await supabase.from('exa_queries').update({ status: 'failed' }).eq('id', queryId);
      throw new Error(`Webset ${websetId} timed out after ${maxAttempts * pollIntervalSeconds} seconds`);
    }

    // Extract items and create leads
    const result = await step.run('extract-leads', async () => {
      const itemsGenerator = exa.websets.items.listAll(websetId);
      const itemsArray: any[] = [];
      for await (const item of itemsGenerator) {
        itemsArray.push(item);
      }

      const leads = [];
      for (const item of itemsArray) {
        const data = item.model_dump ? item.model_dump() : item;

        const name = data.properties?.title || data.properties?.name || 'Unknown';
        const sourceUrl = data.properties?.url ? String(data.properties.url) : '';

        // Extract enrichments
        const email = extractEmailFromEnrichments(data.enrichments);
        const followers = data.enrichments?.followers ||
          data.enrichments?.['Extract the follower or subscriber count if visible']?.value ||
          data.enrichments?.['Extract the follower or subscriber count if visible'] ||
          null;

        // Determine platform
        let platform = 'other';
        if (sourceUrl.includes('tiktok.com')) platform = 'tiktok';
        else if (sourceUrl.includes('instagram.com')) platform = 'instagram';
        else if (sourceUrl.includes('youtube.com')) platform = 'youtube';
        else if (sourceUrl.includes('twitter.com') || sourceUrl.includes('x.com')) platform = 'twitter';
        else if (sourceUrl.includes('linkedin.com')) platform = 'linkedin';

        // Check for duplicate
        if (email) {
          const { data: existing } = await supabase
            .from('leads')
            .select('id')
            .eq('email', email)
            .single();
          if (existing) continue;
        }

        leads.push({
          query_id: queryId,
          webset_run_id: websetRunId,
          name,
          email,
          url: sourceUrl,
          platform,
          follower_count: followers ? parseInt(String(followers), 10) : null,
          enrichment_data: data,
          enrichment_status: 'pending' as const,
          campaign_status: 'pending' as const,
        });
      }

      // Insert leads and get IDs back
      let insertedLeads: Array<{ id: string; url: string; email: string | null; name: string | null }> = [];
      if (leads.length > 0) {
        const { data: inserted, error } = await supabase
          .from('leads')
          .insert(leads)
          .select('id, url, email, name');
        if (error) throw error;
        insertedLeads = inserted || [];
      }

      return { itemsFound: itemsArray.length, leadsCreated: leads.length, insertedLeads };
    });

    // Update webset run and query status
    await step.run('update-status', async () => {
      await supabase
        .from('webset_runs')
        .update({
          status: 'completed',
          items_found: result.itemsFound,
          completed_at: new Date().toISOString(),
        })
        .eq('id', websetRunId);

      await supabase
        .from('exa_queries')
        .update({
          status: 'completed',
          last_run_at: new Date().toISOString(),
        })
        .eq('id', queryId);
    });

    // Trigger enrichment for each lead
    if (result.insertedLeads.length > 0) {
      await step.run('trigger-enrichments', async () => {
        // Get company ID from query
        const { data: queryData } = await supabase
          .from('exa_queries')
          .select('company_id')
          .eq('id', queryId)
          .single();

        if (queryData?.company_id) {
          const enrichmentEvents = result.insertedLeads.map((lead) => ({
            name: 'autogtm/lead.created' as const,
            data: {
              leadId: lead.id,
              leadUrl: lead.url,
              leadEmail: lead.email,
              leadName: lead.name,
              companyId: queryData.company_id,
            },
          }));
          await inngest.send(enrichmentEvents);
          logger.info(`Triggered enrichment for ${result.insertedLeads.length} leads`);
        }
      });
    }

    logger.info(`Completed webset ${websetId}: ${result.itemsFound} items, ${result.leadsCreated} leads`);
    return result;
  }
);

/**
 * Scheduled Query Generation - Fan-out per enabled company.
 *
 * Child (`generateQueriesOnDemand`) processes NEW briefs immediately, and
 * generates at most ONE exploration query per company per UTC day so we
 * stay productive without flooding Exa with low-signal searches.
 */
export const dailyQueryGeneration = inngest.createFunction(
  {
    id: 'daily-query-generation',
    name: 'Scheduled Query Generation',
  },
  { cron: '0 * * * *' },
  async ({ step, logger }) => {
    const supabase = getSupabase();

    const companies = await step.run('get-companies', async () => {
      const { data } = await supabase
        .from('companies')
        .select('id')
        .eq('system_enabled', true);
      return data || [];
    });

    logger.info(`Fanning out query generation to ${companies.length} companies`);

    if (companies.length > 0) {
      await step.sendEvent(
        'fanout-query-gen',
        companies.map((c: { id: string }) => ({
          name: 'autogtm/queries.generate' as const,
          data: { companyId: c.id, trigger: 'cron' as const },
        }))
      );
    }

    return { companiesProcessed: companies.length };
  }
);

/**
 * On-demand Query Generation - Triggered manually from the dashboard
 * Same logic as daily generation but for a single company
 */
export const generateQueriesOnDemand = inngest.createFunction(
  {
    id: 'generate-queries-on-demand',
    name: 'Generate Queries On Demand',
    retries: 1,
    concurrency: [{ key: 'event.data.companyId', limit: 1 }],
  },
  { event: 'autogtm/queries.generate' },
  async ({ event, step, logger }) => {
    const { companyId, trigger } = event.data as { companyId: string; trigger?: 'cron' | 'manual' };
    const isScheduled = trigger === 'cron';
    const supabase = getSupabase();

    const systemOn = await step.run('check-system', () => isSystemEnabled(supabase, companyId));
    if (!systemOn) {
      logger.info(`System disabled for company ${companyId}, skipping query generation`);
      return { skipped: true };
    }

    const company = await step.run('get-company', async () => {
      const { data } = await supabase
        .from('companies')
        .select('id, name, website, description, target_audience, agent_notes')
        .eq('id', companyId)
        .single();
      return data;
    });

    if (!company) throw new Error(`Company ${companyId} not found`);

    const createdQueryIds: string[] = [];

    const unprocessedInstructions = await step.run('check-instructions', async () => {
      const { data } = await supabase
        .from('company_updates')
        .select('id, content, created_at')
        .eq('company_id', company.id)
        .eq('query_generated', false)
        .order('created_at', { ascending: true });
      return data || [];
    });

    if (unprocessedInstructions.length > 0) {
      for (const instruction of unprocessedInstructions) {
        const queryId = await step.run(`focused-query-${instruction.id}`, async () => {
          const { generateFocusedQuery } = await import('@autogtm/core/ai/generateDailyQuery');
          const newQuery = await generateFocusedQuery({
            company: { name: company.name, website: company.website, description: company.description, targetAudience: company.target_audience },
            instruction: instruction.content,
          });
          const { data, error } = await supabase.from('exa_queries').insert({
            company_id: company.id, query: newQuery.query, criteria: newQuery.criteria,
            is_active: true, status: 'pending', source_instruction_id: instruction.id, generation_rationale: newQuery.rationale,
          }).select('id').single();
          if (error) throw error;
          await supabase.from('company_updates').update({ query_generated: true }).eq('id', instruction.id);
          return data.id as string;
        });
        createdQueryIds.push(queryId);
      }
    } else {
      if (isScheduled) {
        const already = await step.run('check-exploration-today', () => hasExplorationQueryToday(supabase, company.id));
        if (already) {
          logger.info(`Exploration query already generated today for ${company.name}, skipping`);
          return { queriesGenerated: 0, skipped: true, reason: 'exploration_already_today' };
        }
      }
      const queryId = await step.run('exploration-query', async () => {
        const { generateExplorationQuery } = await import('@autogtm/core/ai/generateDailyQuery');
        const { data: pastQueries } = await supabase.from('exa_queries').select('query, criteria').eq('company_id', company.id).order('created_at', { ascending: false }).limit(20);
        const newQuery = await generateExplorationQuery({
          company: { name: company.name, website: company.website, description: company.description, targetAudience: company.target_audience, agentNotes: company.agent_notes },
          pastQueries: (pastQueries || []).map(q => ({ ...q, leads_found: 0 })),
        });
        const { data, error } = await supabase.from('exa_queries').insert({
          company_id: company.id, query: newQuery.query, criteria: newQuery.criteria,
          is_active: true, status: 'pending', generation_rationale: newQuery.rationale,
        }).select('id').single();
        if (error) throw error;
        return data.id as string;
      });
      createdQueryIds.push(queryId);
    }

    // Scheduled generations kick off searches immediately; the hourly webset
    // cron is a catch-up for anything still pending. Child enforces the daily cap.
    if (isScheduled && createdQueryIds.length > 0) {
      await step.sendEvent(
        'queue-websets',
        createdQueryIds.map((queryId) => ({
          name: 'autogtm/daily-webset.run-company' as const,
          data: { companyId: company.id, companyName: company.name, queryId },
        }))
      );
    }

    logger.info(`Generated ${createdQueryIds.length} queries for ${company.name}`);
    return { queriesGenerated: createdQueryIds.length, queryIds: createdQueryIds };
  }
);

/**
 * Targeted Query Generation - Generate query for one specific instruction
 */
export const generateQueryForInstruction = inngest.createFunction(
  {
    id: 'generate-query-for-instruction',
    name: 'Generate Query For Instruction',
    retries: 1,
    concurrency: [{ key: 'event.data.instructionId', limit: 1 }],
  },
  { event: 'autogtm/queries.generate-for-instruction' },
  async ({ event, step, logger }) => {
    const { companyId, instructionId } = event.data as { companyId: string; instructionId: string };
    const supabase = getSupabase();

    const systemOn = await step.run('check-system', () => isSystemEnabled(supabase, companyId));
    if (!systemOn) {
      logger.info(`System disabled for company ${companyId}, skipping targeted generation`);
      return { skipped: true };
    }

    const company = await step.run('get-company', async () => {
      const { data } = await supabase
        .from('companies')
        .select('id, name, website, description, target_audience')
        .eq('id', companyId)
        .single();
      return data;
    });

    const instruction = await step.run('get-instruction', async () => {
      const { data } = await supabase
        .from('company_updates')
        .select('id, company_id, content, query_generated')
        .eq('id', instructionId)
        .eq('company_id', companyId)
        .single();
      return data;
    });

    if (!company) throw new Error(`Company ${companyId} not found`);
    if (!instruction) throw new Error(`Instruction ${instructionId} not found for company ${companyId}`);

    const existingQuery = await step.run('check-existing-query', async () => {
      const { data } = await supabase
        .from('exa_queries')
        .select('id')
        .eq('company_id', companyId)
        .eq('source_instruction_id', instructionId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    });

    if (existingQuery?.id) {
      logger.info(`Query already exists for instruction ${instructionId}: ${existingQuery.id}`);
      return { queryId: existingQuery.id, reused: true };
    }

    const generated = await step.run('generate-focused-query', async () => {
      const { generateFocusedQuery } = await import('@autogtm/core/ai/generateDailyQuery');
      return generateFocusedQuery({
        company: {
          name: company.name,
          website: company.website,
          description: company.description,
          targetAudience: company.target_audience,
        },
        instruction: instruction.content,
      });
    });

    const insertedQuery = await step.run('insert-query', async () => {
      const { data, error } = await supabase
        .from('exa_queries')
        .insert({
          company_id: companyId,
          query: generated.query,
          criteria: generated.criteria,
          is_active: true,
          status: 'pending',
          source_instruction_id: instructionId,
          generation_rationale: generated.rationale,
        })
        .select('id')
        .single();
      if (error) throw error;
      return data;
    });

    await step.run('mark-instruction-processed', async () => {
      await supabase
        .from('company_updates')
        .update({ query_generated: true })
        .eq('id', instructionId);
    });

    logger.info(`Generated query ${insertedQuery.id} for instruction ${instructionId}`);
    return { queryId: insertedQuery.id, reused: false };
  }
);

/**
 * Scheduled Webset Search (parent) - Hourly catch-up: pending queries FIFO,
 * capped at WEBSETS_PER_COMPANY_PER_DAY. Cron-generated queries also fan out
 * immediately; this cron picks up anything still queued (manual creates, cap
 * leftovers, retries).
 */
export const dailyWebsetSearch = inngest.createFunction(
  {
    id: 'daily-webset-search',
    name: 'Scheduled Webset Search',
  },
  { cron: '20 * * * *' },
  async ({ step, logger }) => {
    const supabase = getSupabase();

    const payloads = await step.run('plan-company-queries', async () => {
      const { data: companies } = await supabase.from('companies').select('id, name').eq('system_enabled', true);
      const planned: Array<{ companyId: string; companyName: string; queryId: string }> = [];
      for (const c of companies || []) {
        const used = await countWebsetRunsToday(supabase, c.id);
        const remaining = WEBSETS_PER_COMPANY_PER_DAY - used;
        if (remaining <= 0) continue;
        const { data: queries } = await supabase
          .from('exa_queries')
          .select('id, status, webset_runs(id)')
          .eq('company_id', c.id)
          .eq('is_active', true)
          .in('status', ['pending', 'failed'])
          .order('created_at', { ascending: true })
          .limit(remaining + 10);
        const eligible = ((queries || []) as Array<{ id: string; status: string; webset_runs?: { id: string }[] | null }>)
          .filter((q) => q.status === 'pending' || !q.webset_runs?.length)
          .slice(0, remaining);
        for (const q of eligible) {
          planned.push({ companyId: c.id, companyName: c.name, queryId: q.id });
        }
      }
      return planned;
    });

    logger.info(`Fanning out ${payloads.length} query runs`);

    if (payloads.length > 0) {
      await step.sendEvent(
        'fan-out',
        payloads.map((p) => ({
          name: 'autogtm/daily-webset.run-company' as const,
          data: p,
        }))
      );
    }

    return { queryRuns: payloads.length };
  }
);

/**
 * Run company webset search (child) - One query per event.
 * No retries to avoid burning Exa credits. Per-company concurrency 1 + daily
 * cap keep quality/spend in check while the parent can queue several queries.
 */
export const runCompanyWebsetSearch = inngest.createFunction(
  {
    id: 'run-company-webset-search',
    name: 'Run Company Webset Search',
    retries: 0,
    concurrency: { key: 'event.data.companyId', limit: 1 },
    throttle: { limit: 2, period: '1m', key: 'event.data.companyId' },
  },
  { event: 'autogtm/daily-webset.run-company' },
  async ({ event, step, logger }) => {
    const { companyId, companyName, queryId: requestedQueryId } = event.data as {
      companyId: string;
      companyName?: string;
      queryId?: string;
    };
    const supabase = getSupabase();

    const queryToRun = await step.run('claim-query', async () => {
      const used = await countWebsetRunsToday(supabase, companyId);
      if (used >= WEBSETS_PER_COMPANY_PER_DAY) return null;

      if (requestedQueryId) {
        const { data } = await supabase
          .from('exa_queries')
          .update({ status: 'running' })
          .eq('id', requestedQueryId)
          .eq('company_id', companyId)
          .eq('is_active', true)
          .in('status', ['pending', 'failed'])
          .select('*')
          .maybeSingle();
        return data;
      }

      const { data: queries } = await supabase
        .from('exa_queries')
        .select('id')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .in('status', ['pending', 'failed'])
        .order('created_at', { ascending: true })
        .limit(1);
      const candidateId = queries?.[0]?.id;
      if (!candidateId) return null;
      const { data } = await supabase
        .from('exa_queries')
        .update({ status: 'running' })
        .eq('id', candidateId)
        .in('status', ['pending', 'failed'])
        .select('*')
        .maybeSingle();
      return data;
    });

    if (!queryToRun) {
      logger.info(`No pending queries (or daily cap reached) for ${companyName ?? companyId}`);
      return { skipped: true };
    }

    logger.info(`Running query for ${companyName ?? companyId}: "${queryToRun.query}"`);

    let discovery: Awaited<ReturnType<typeof discoverLeads>>;
    try {
      discovery = await step.run('create-webset', async () => {
        return discoverLeads({
          query: queryToRun.query,
          count: 25,
          criteria: queryToRun.criteria,
          enrichments: [
            { description: 'Find the email address for this person or creator', format: 'email' },
            { description: 'Extract the follower or subscriber count if visible', format: 'number' },
          ],
        });
      });
    } catch (error) {
      await step.run('mark-failed', async () => {
        await supabase.from('exa_queries').update({ status: 'failed' }).eq('id', queryToRun.id);
      });
      logger.error(`Exa discovery failed for ${queryToRun.id}: ${formatExaError(error)}`);
      throw error;
    }

    if (discovery.mode === 'search') {
      logger.info(`Websets unavailable; using Exa search fallback for ${queryToRun.id} (${discovery.hits.length} hits)`);
      const ingested = await step.run('ingest-search-fallback', () =>
        ingestSearchHits({
          supabase,
          queryId: queryToRun.id,
          companyId,
          hits: discovery.hits,
          sendLeadEvents: (events) => inngest.send(events),
        })
      );
      return {
        companyId,
        queryId: queryToRun.id,
        fallback: 'search' as const,
        itemsFound: ingested.itemsFound,
        leadsCreated: ingested.leadsCreated,
      };
    }

    const websetId = discovery.websetId;

    await step.run('dispatch-webset', async () => {
      const { data: websetRun } = await supabase
        .from('webset_runs')
        .insert({
          query_id: queryToRun.id,
          webset_id: websetId,
          status: 'running',
          items_found: 0,
          started_at: new Date().toISOString(),
        })
        .select()
        .single();

      await inngest.send({
        name: 'autogtm/webset.created',
        data: {
          queryId: queryToRun.id,
          websetId,
          websetRunId: websetRun?.id,
        },
      });
    });

    return { companyId, queryId: queryToRun.id, websetId };
  }
);

type DigestSearchRow = { query: string; leadsFound: number };
type DigestRoutedRow = { name: string; search: string; campaign: string };

/**
 * Daily Digest - Per-company daily summary email.
 * Recipient is pulled from `companies.auto_add_digest_email` (same DB column the
 * autopilot digest uses) — no env-var hack. Each company gets a digest scoped to
 * its own leads + campaigns, so multi-tenant inboxes stay clean.
 */
export const dailyDigest = inngest.createFunction(
  {
    id: 'daily-digest',
    name: 'Daily Digest',
  },
  { cron: '0 18 * * *' }, // 6 PM every day
  async ({ step, logger }) => {
    const today = new Date().toISOString().split('T')[0];
    const dayStart = `${today}T00:00:00Z`;
    const dayEnd = `${today}T23:59:59Z`;

    const supabase = getSupabase();

    const companies = await step.run('list-digest-companies', async () => {
      const { data, error } = await supabase
        .from('companies')
        .select('id, name, auto_add_digest_email')
        .eq('system_enabled', true)
        .not('auto_add_digest_email', 'is', null)
        .neq('auto_add_digest_email', '');
      if (error) throw error;
      return (data || []) as Array<{ id: string; name: string; auto_add_digest_email: string }>;
    });

    if (companies.length === 0) {
      logger.info('Daily digest: no companies with digest email configured');
      return { date: today, companies: 0 };
    }

    const results: Array<{ companyId: string; sent: boolean; leads: number; emails: number }> = [];

    for (const company of companies) {
      const result = await step.run(`digest-${company.id}`, async () => {
        // Company campaigns (id -> name) for routed-leads section
        const { data: companyCampaigns } = await supabase
          .from('campaigns')
          .select('id, name, instantly_campaign_id')
          .eq('company_id', company.id);
        const campaignNameById = new Map<string, string>(
          (companyCampaigns || []).map((c: { id: string; name: string }) => [c.id, c.name])
        );
        const campaignIds = (companyCampaigns || []).map((c: { id: string }) => c.id);

        // Section 1 — today's searches: webset_runs started today, joined to query text.
        const { data: companyQueries } = await supabase
          .from('exa_queries')
          .select('id, query')
          .eq('company_id', company.id);
        const queryTextById = new Map<string, string>(
          (companyQueries || []).map((q: { id: string; query: string }) => [q.id, q.query])
        );
        const queryIds = (companyQueries || []).map((q: { id: string }) => q.id);

        const searches: DigestSearchRow[] = [];
        if (queryIds.length > 0) {
          const { data: runs } = await supabase
            .from('webset_runs')
            .select('query_id, items_found')
            .in('query_id', queryIds)
            .gte('started_at', dayStart)
            .lte('started_at', dayEnd)
            .order('items_found', { ascending: false });
          // Aggregate by query (a query may run multiple times in a day)
          const byQuery = new Map<string, number>();
          for (const r of (runs || []) as Array<{ query_id: string; items_found: number }>) {
            byQuery.set(r.query_id, (byQuery.get(r.query_id) || 0) + (r.items_found || 0));
          }
          for (const [qid, count] of byQuery.entries()) {
            searches.push({ query: queryTextById.get(qid) || 'Unknown search', leadsFound: count });
          }
          searches.sort((a, b) => b.leadsFound - a.leadsFound);
        }
        const leadsFoundTotal = searches.reduce((sum, s) => sum + s.leadsFound, 0);

        // Section 2 — leads reached out today (routed today into one of this company's campaigns)
        const reachedOut: DigestRoutedRow[] = [];
        if (campaignIds.length > 0) {
          const { data: routed } = await supabase
            .from('leads')
            .select('full_name, query_id, campaign_id, campaign_routed_at')
            .in('campaign_id', campaignIds)
            .gte('campaign_routed_at', dayStart)
            .lte('campaign_routed_at', dayEnd)
            .order('campaign_routed_at', { ascending: false });
          for (const l of (routed || []) as Array<{ full_name: string | null; query_id: string | null; campaign_id: string | null }>) {
            reachedOut.push({
              name: l.full_name?.trim() || 'Unnamed lead',
              search: (l.query_id && queryTextById.get(l.query_id)) || '—',
              campaign: (l.campaign_id && campaignNameById.get(l.campaign_id)) || '—',
            });
          }
        }

        // Section 3 — net outbound stats (Instantly, all company campaigns; doubles as analytics sync)
        const stats = { sent: 0, opens: 0, replies: 0 };
        for (const c of (companyCampaigns || [])) {
          if (!c.instantly_campaign_id) continue;
          try {
            const analytics = await getCampaignAnalytics(c.instantly_campaign_id);
            stats.sent += analytics.sent;
            stats.opens += analytics.opened;
            stats.replies += analytics.replied;
            await updateCampaignStats(c.id, {
              emails_sent: analytics.sent,
              opens: analytics.opened,
              replies: analytics.replied,
            });
          } catch (e) {
            logger.error(`Daily digest: analytics failed for campaign ${c.id}:`, e);
          }
        }

        try {
          await getResend().emails.send({
            from: process.env.DIGEST_FROM_EMAIL || 'autogtm <noreply@example.com>',
            to: [company.auto_add_digest_email],
            subject: `autogtm Digest · ${company.name} · ${today} · ${leadsFoundTotal} found · ${reachedOut.length} reached`,
            html: renderDailyDigestHtml({
              companyName: company.name,
              date: today,
              searches,
              reachedOut,
              leadsFoundTotal,
              stats,
              appUrl: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3200',
            }),
          });
          logger.info(`Daily digest sent for ${company.name} -> ${company.auto_add_digest_email}`);
          return { companyId: company.id, sent: true, leads: leadsFoundTotal, emails: stats.sent };
        } catch (e) {
          logger.error(`Daily digest: send failed for company ${company.id}:`, e);
          return { companyId: company.id, sent: false, leads: leadsFoundTotal, emails: stats.sent };
        }
      });
      results.push(result);
    }

    return {
      date: today,
      companies: companies.length,
      results,
    };
  }
);

function renderDailyDigestHtml(params: {
  companyName: string;
  date: string;
  searches: DigestSearchRow[];
  reachedOut: DigestRoutedRow[];
  leadsFoundTotal: number;
  stats: { sent: number; opens: number; replies: number };
  appUrl: string;
}): string {
  const { companyName, date, searches, reachedOut, leadsFoundTotal, stats, appUrl } = params;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const truncate = (s: string, n: number) => s.length > n ? esc(s.slice(0, n)) + '…' : esc(s);

  const searchRows = searches.length === 0
    ? `<tr><td colspan="2" style="padding:14px;text-align:center;color:#999;font-size:13px;">No searches ran today.</td></tr>`
    : searches.map((s) => `
        <tr>
          <td style="padding:10px 14px;border-top:1px solid #eee;font-size:13px;color:#111;">${truncate(s.query, 120)}</td>
          <td style="padding:10px 14px;border-top:1px solid #eee;font-size:13px;color:#111;text-align:right;"><strong>${s.leadsFound}</strong></td>
        </tr>
      `).join('');

  const reachedRows = reachedOut.length === 0
    ? `<tr><td colspan="3" style="padding:14px;text-align:center;color:#999;font-size:13px;">No leads reached out today.</td></tr>`
    : reachedOut.map((r) => `
        <tr>
          <td style="padding:10px 14px;border-top:1px solid #eee;font-size:13px;color:#111;font-weight:600;">${esc(r.name)}</td>
          <td style="padding:10px 14px;border-top:1px solid #eee;font-size:13px;color:#555;">${truncate(r.search, 80)}</td>
          <td style="padding:10px 14px;border-top:1px solid #eee;font-size:13px;color:#555;">${truncate(r.campaign, 80)}</td>
        </tr>
      `).join('');

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
    <div style="max-width:680px;margin:0 auto;padding:32px 20px;">
      <div style="background:#fff;border-radius:12px;border:1px solid #eee;overflow:hidden;">
        <div style="padding:24px 28px;background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#fff;">
          <div style="font-size:13px;opacity:.8;letter-spacing:.04em;text-transform:uppercase;">autogtm · Daily Digest · ${esc(date)}</div>
          <div style="font-size:28px;font-weight:700;margin-top:6px;">${esc(companyName)}</div>
          <div style="font-size:15px;margin-top:10px;opacity:.9;">${leadsFoundTotal} found · ${reachedOut.length} reached out</div>
        </div>

        <div style="padding:24px 28px;">
          <h3 style="margin:0 0 12px 0;font-size:14px;color:#666;font-weight:600;letter-spacing:.03em;text-transform:uppercase;">Today's searches</h3>
          <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden;">
            <thead>
              <tr style="background:#fafafa;">
                <th style="padding:10px 14px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Search</th>
                <th style="padding:10px 14px;text-align:right;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Leads found</th>
              </tr>
            </thead>
            <tbody>${searchRows}</tbody>
          </table>

          <h3 style="margin:28px 0 12px 0;font-size:14px;color:#666;font-weight:600;letter-spacing:.03em;text-transform:uppercase;">Reached out today</h3>
          <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden;">
            <thead>
              <tr style="background:#fafafa;">
                <th style="padding:10px 14px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Name</th>
                <th style="padding:10px 14px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Search</th>
                <th style="padding:10px 14px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Campaign</th>
              </tr>
            </thead>
            <tbody>${reachedRows}</tbody>
          </table>

          <div style="margin-top:24px;padding:14px 16px;background:#f9fafb;border-radius:8px;font-size:13px;color:#555;text-align:center;">
            <strong style="color:#111;">${stats.sent}</strong> emails sent ·
            <strong style="color:#111;">${stats.opens}</strong> opens ·
            <strong style="color:#111;">${stats.replies}</strong> replies
            <span style="color:#999;"> (all-time, all campaigns)</span>
          </div>

          <div style="margin-top:24px;text-align:center;">
            <a href="${esc(appUrl)}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">View Dashboard</a>
          </div>
        </div>

        <div style="padding:16px 28px;border-top:1px solid #eee;font-size:12px;color:#999;">
          autogtm · ${esc(companyName)} · ${esc(date)}
        </div>
      </div>
    </div>
  </body>
</html>`;
}

/**
 * Sync Campaign Analytics - Runs every hour to update stats
 */
export const syncCampaignAnalytics = inngest.createFunction(
  {
    id: 'sync-campaign-analytics',
    name: 'Sync Campaign Analytics',
  },
  { cron: '0 * * * *' }, // Every hour
  async ({ step, logger }) => {
    const supabase = getSupabase();

    const campaigns = await step.run('get-live-campaigns', async () => {
      const supabase = getSupabase();
      const { data } = await supabase
        .from('campaigns')
        .select('*')
        .not('instantly_campaign_id', 'is', null)
        .in('status', ['draft', 'active', 'paused', 'completed']);
      return data || [];
    });

    let updated = 0;
    for (const campaign of campaigns) {
      await step.run(`sync-campaign-${campaign.id}`, async () => {
        try {
          const instantlyCampaign = await getCampaign(campaign.instantly_campaign_id);
          const nextStatus = mapInstantlyCampaignStatus(instantlyCampaign.status);

          if (nextStatus !== campaign.status) {
            await supabase
              .from('campaigns')
              .update({ status: nextStatus, updated_at: new Date().toISOString() })
              .eq('id', campaign.id);
            logger.info(`Campaign ${campaign.id} status synced: ${campaign.status} -> ${nextStatus}`);
          }

          if (nextStatus === 'active') {
            const analytics = await getCampaignAnalytics(campaign.instantly_campaign_id);
            await updateCampaignStats(campaign.id, {
              emails_sent: analytics.sent,
              opens: analytics.opened,
              replies: analytics.replied,
            });
          }
          updated++;
        } catch (e) {
          logger.error(`Failed to sync campaign ${campaign.id}:`, e);
        }
      });
    }

    return { campaignsUpdated: updated };
  }
);

// Helper function to detect platform from URL
function detectPlatform(url: string): string | null {
  const urlLower = url.toLowerCase();
  if (urlLower.includes('tiktok.com')) return 'tiktok';
  if (urlLower.includes('instagram.com')) return 'instagram';
  if (urlLower.includes('youtube.com') || urlLower.includes('youtu.be')) return 'youtube';
  if (urlLower.includes('twitter.com') || urlLower.includes('x.com')) return 'twitter';
  if (urlLower.includes('linkedin.com')) return 'linkedin';
  return null;
}

/**
 * Enrich Lead - AI-powered lead enrichment using OpenAI web search
 * Triggered when a new lead is created
 */
export const enrichLeadJob = inngest.createFunction(
  {
    id: 'enrich-lead',
    name: 'Enrich Lead',
    retries: 2,
    concurrency: [
      { key: 'event.data.companyId', limit: 3 },
      { limit: 8 },
    ],
    throttle: { limit: 12, period: '1m' },
  },
  { event: 'autogtm/lead.created' },
  async ({ event, step, logger }) => {
    const { leadId, leadUrl, leadEmail, leadName, companyId } = event.data;
    const supabase = getSupabase();

    // Check system enabled
    const systemOn = await step.run('check-system', () => isSystemEnabled(supabase, companyId));
    if (!systemOn) {
      logger.info(`System disabled for company ${companyId}, skipping enrichment`);
      return { skipped: true };
    }

    logger.info(`Enriching lead ${leadId}`);

    // Mark as enriching
    await supabase
      .from('leads')
      .update({ enrichment_status: 'enriching' })
      .eq('id', leadId);

    // Get company context
    const company = await step.run('get-company', async () => {
      const { data } = await supabase
        .from('companies')
        .select('name, description, target_audience, sending_emails, default_sequence_length, email_prompt, auto_add_enabled, auto_add_min_fit_score')
        .eq('id', companyId)
        .single();
      return data;
    });

    if (!company) {
      logger.error(`Company ${companyId} not found`);
      await supabase
        .from('leads')
        .update({ enrichment_status: 'failed' })
        .eq('id', leadId);
      throw new Error(`Company ${companyId} not found`);
    }

    // Run AI enrichment - dump all raw data, let the model figure it out
    const enrichedData = await step.run('enrich-with-ai', async () => {
      const { data: leadRow } = await supabase.from('leads').select('*').eq('id', leadId).single();
      return enrichLead(
        leadRow || { url: leadUrl, email: leadEmail, name: leadName },
        { name: company.name, description: company.description, targetAudience: company.target_audience },
      );
    });

    // Resolve email: use existing > enrichment agent found > AI extract from Exa data
    const resolvedEmail = await step.run('resolve-email', async () => {
      if (leadEmail) return leadEmail;
      if (enrichedData.email) return enrichedData.email;
      
      // Try AI extraction from Exa enrichment_data
      const { data: leadData } = await supabase.from('leads').select('enrichment_data').eq('id', leadId).single();
      if (leadData?.enrichment_data) {
        const extracted = await extractEmailFromEnrichmentData(leadData.enrichment_data);
        if (extracted) return extracted;
      }
      return null;
    });

    // Update lead with enriched data + resolved email
    await step.run('update-lead', async () => {
      const updateData: Record<string, any> = {
        category: normalizeLeadCategory(enrichedData.category),
        full_name: enrichedData.full_name,
        title: enrichedData.title,
        bio: enrichedData.bio,
        expertise: enrichedData.expertise,
        social_links: enrichedData.social_links,
        total_audience: enrichedData.total_audience,
        content_types: enrichedData.content_types,
        promotion_fit_score: enrichedData.promotion_fit_score,
        promotion_fit_reason: enrichedData.promotion_fit_reason,
        enrichment_status: 'enriched',
        enriched_at: new Date().toISOString(),
      };
      if (resolvedEmail && !leadEmail) {
        updateData.email = resolvedEmail;
      }
      const { error } = await supabase.from('leads').update(updateData).eq('id', leadId);
      if (error) {
        logger.error(`Failed to update lead ${leadId}:`, error);
        throw error;
      }
    });

    logger.info(`Enriched lead ${leadId}: ${enrichedData.full_name} (${enrichedData.category}) email: ${resolvedEmail || 'none'}`);

    // Auto-skip if still no email after all attempts
    if (!resolvedEmail) {
      await step.run('skip-no-email', () => markLeadSkipped(leadId, 'No email address found'));
      return { leadId, fullName: enrichedData.full_name, category: enrichedData.category, fitScore: enrichedData.promotion_fit_score, routing: { action: 'skipped', reason: 'No email' } };
    }

    // Suggest a campaign for this lead (user will confirm from dashboard)
    const routingDecision = await step.run('decide-campaign', async () => {
      return determineCampaignForLead({
        lead: {
          email: resolvedEmail,
          full_name: enrichedData.full_name,
          category: enrichedData.category,
          platform: detectPlatform(leadUrl || '') || null,
          bio: enrichedData.bio,
          expertise: enrichedData.expertise,
          total_audience: enrichedData.total_audience,
          content_types: enrichedData.content_types,
          promotion_fit_score: enrichedData.promotion_fit_score,
          promotion_fit_reason: enrichedData.promotion_fit_reason,
        },
        campaigns: [],
        company: { name: company.name, description: company.description, target_audience: company.target_audience },
        autoMode: true,
      });
    });

    logger.info(`Routing decision for ${leadId}: ${routingDecision.action} - ${routingDecision.reason}`);

    if (routingDecision.action === 'skip') {
      await step.run('mark-skipped', () => markLeadSkipped(leadId, routingDecision.reason));
      return { leadId, fullName: enrichedData.full_name, category: enrichedData.category, fitScore: enrichedData.promotion_fit_score, routing: { action: 'skipped' } };
    }

    // Create per-lead draft campaign, then set as suggestion.
    const existingDraft = await step.run('get-existing-draft', () => getCampaignBySourceLeadId(leadId));
    const resolvedPrompt = await step.run('resolve-outreach-prompt', () => resolveOutreachPromptForLead({
      supabase,
      companyId,
      leadId,
      companyEmailPrompt: company.email_prompt,
    }));
    logger.info(`Prompt resolution for ${leadId}: ${resolvedPrompt.source}`);
    const campaign = existingDraft || await step.run('create-draft-campaign', () =>
      createDraftCampaignForLead({
        company: { id: companyId, name: company.name, description: company.description, target_audience: company.target_audience, sending_emails: company.sending_emails, default_sequence_length: company.default_sequence_length, email_prompt: company.email_prompt },
        resolvedEmailPrompt: resolvedPrompt.prompt,
        suggestedName: routingDecision.suggestedName,
        suggestedPersona: routingDecision.suggestedPersona,
        leadId,
        leadFullName: enrichedData.full_name,
        leadBio: enrichedData.bio,
        leadCategory: enrichedData.category,
      })
    );
    const suggestedCampaignId = campaign.id;

    await step.run('set-suggested-campaign', () =>
      setSuggestedCampaign(leadId, suggestedCampaignId, routingDecision.reason)
    );

    // Autopilot is not triggered inline. The scheduled sweep plus same-day catch-up
    // (`autoAddSweep`) pick Ready-to-Add leads, still gated by daily_limit and min_fit_score.
    return { leadId, fullName: enrichedData.full_name, category: enrichedData.category, fitScore: enrichedData.promotion_fit_score, routing: { action: 'suggested', campaignId: suggestedCampaignId } };
  }
);

/**
 * Add Lead to Campaign - Triggered when user confirms adding a lead to its suggested campaign
 * The lead must already have a suggested_campaign_id set by the enrichment flow
 */
export const addLeadToCampaignJob = inngest.createFunction(
  {
    id: 'add-lead-to-campaign',
    name: 'Add Lead to Campaign',
    retries: 2,
    concurrency: { limit: 5 },
  },
  { event: 'autogtm/lead.add-to-campaign' },
  async ({ event, step, logger }) => {
    const { leadId, campaignId } = event.data;
    logger.info(`Adding lead ${leadId} to campaign ${campaignId}`);

    await step.run('route-lead', () => addLeadToCampaignCore({ leadId, campaignId }));

    logger.info(`Lead ${leadId} added to campaign ${campaignId}`);
    return { leadId, campaignId };
  }
);

/**
 * Auto Add Sweep - Hourly planner.
 * At each company's `auto_add_run_hour_utc` (default 14 / 10am ET): primary
 * sweep + digest. Later hours the same UTC day: catch-up that fills remaining
 * daily_limit as enrichment finishes, without extra digest emails.
 */
export const autoAddSweep = inngest.createFunction(
  { id: 'auto-add-sweep', name: 'Auto Add Sweep' },
  { cron: '5 * * * *' },
  async ({ step, logger }) => {
    const companies = await step.run('list-auto-enabled-companies', () => listAutoEnabledCompanies());
    const hour = new Date().getUTCHours();

    const planned = await step.run('plan-sweeps', async () => {
      const events: Array<{ companyId: string; trigger: 'cron' | 'catchup' }> = [];
      for (const c of companies) {
        const runHour = c.auto_add_run_hour_utc ?? 14;
        if (hour === runHour) {
          events.push({ companyId: c.id, trigger: 'cron' });
          continue;
        }
        if (hour > runHour) {
          const added = await countLeadsAddedToday(c.id);
          const remaining = (c.auto_add_daily_limit ?? 5) - added;
          if (remaining > 0) events.push({ companyId: c.id, trigger: 'catchup' });
        }
      }
      return events;
    });

    logger.info(`Autopilot sweep hour=${hour}: ${planned.length} company events (${companies.length} enabled)`);

    if (planned.length === 0) return { companies: companies.length, events: 0 };

    await step.sendEvent('fanout-auto-sweep', planned.map((p) => ({
      name: 'autogtm/auto-add.sweep-company' as const,
      data: { companyId: p.companyId, trigger: p.trigger },
    })));

    return { companies: companies.length, events: planned.length };
  }
);

/**
 * Auto Add Sweep (per-company) - picks top N leads, routes each via the shared
 * core, aggregates a per-campaign breakdown, writes an audit row and emails a digest.
 */
export const autoAddSweepCompany = inngest.createFunction(
  {
    id: 'auto-add-sweep-company',
    name: 'Auto Add Sweep (Company)',
    concurrency: { key: 'event.data.companyId', limit: 1 },
    retries: 1,
  },
  { event: 'autogtm/auto-add.sweep-company' },
  async ({ event, step, logger }) => {
    const { companyId, trigger } = event.data as { companyId: string; trigger: 'cron' | 'manual' | 'catchup' };
    const supabase = getSupabase();

    // Load company + verify autopilot still on (prefs may have flipped between fanout and run)
    const company = await step.run('load-company', async () => {
      const { data } = await supabase
        .from('companies')
        .select('id, name, system_enabled, auto_add_enabled, auto_add_min_fit_score, auto_add_daily_limit, auto_add_digest_email, auto_add_regenerate_drafts')
        .eq('id', companyId)
        .single();
      return data as {
        id: string;
        name: string;
        system_enabled: boolean;
        auto_add_enabled: boolean;
        auto_add_min_fit_score: number;
        auto_add_daily_limit: number;
        auto_add_digest_email: string | null;
        auto_add_regenerate_drafts: boolean;
      } | null;
    });

    if (!company) {
      logger.warn(`Autopilot sweep: company ${companyId} not found`);
      return { skipped: true, reason: 'company_not_found' };
    }
    if (!company.system_enabled) {
      logger.info(`Autopilot sweep: company ${companyId} has System OFF, skipping (even for manual triggers)`);
      return { skipped: true, reason: 'system_disabled' };
    }
    if (!company.auto_add_enabled && trigger !== 'manual') {
      logger.info(`Autopilot sweep: company ${companyId} disabled, skipping`);
      return { skipped: true, reason: 'disabled' };
    }

    const minFitScore = company.auto_add_min_fit_score || 7;
    const dailyLimit = company.auto_add_daily_limit ?? 5;
    const regenerateDraftFirst = company.auto_add_regenerate_drafts === true;

    const addedToday = await step.run('count-added-today', () => countLeadsAddedToday(companyId));
    const remaining = trigger === 'manual'
      ? dailyLimit
      : Math.max(0, dailyLimit - addedToday);

    if (dailyLimit <= 0) {
      if (trigger === 'catchup') return { skipped: true, reason: 'daily_limit_zero' };
      const run = await step.run('create-run-zero-limit', () =>
        createAutoAddRun({ companyId, minFitScore, dailyLimit, trigger })
      );
      await step.run('complete-run-zero-limit', () =>
        completeAutoAddRun(run.id, { leads_considered: 0, leads_added: 0, leads_skipped: 0, error: null })
      );
      return { runId: run.id, added: 0, reason: 'daily_limit_zero' };
    }

    if (remaining <= 0) {
      if (trigger === 'catchup') return { skipped: true, reason: 'daily_limit_reached' };
      const run = await step.run('create-run-capped', () =>
        createAutoAddRun({ companyId, minFitScore, dailyLimit, trigger })
      );
      await step.run('complete-run-capped', () =>
        completeAutoAddRun(run.id, { leads_considered: 0, leads_added: 0, leads_skipped: 0, error: null })
      );
      return { runId: run.id, added: 0, reason: 'daily_limit_reached' };
    }

    const candidates = await step.run('fetch-candidates', () =>
      getEligibleLeadsForAutoAdd(companyId, minFitScore, remaining)
    );

    if (candidates.length === 0) {
      if (trigger === 'catchup') {
        logger.info(`Autopilot catch-up: company ${companyId} — 0 qualifying leads, skipping`);
        return { skipped: true, reason: 'no_candidates' };
      }
      const run = await step.run('create-run-empty', () =>
        createAutoAddRun({ companyId, minFitScore, dailyLimit, trigger })
      );
      await step.run('complete-run-empty', () =>
        completeAutoAddRun(run.id, { leads_considered: 0, leads_added: 0, leads_skipped: 0, error: null })
      );
      logger.info(`Autopilot sweep: company ${companyId} — 0 qualifying leads, skipping digest`);
      return { runId: run.id, added: 0 };
    }

    const run = await step.run('create-run', () =>
      createAutoAddRun({ companyId, minFitScore, dailyLimit, trigger })
    );

    // Route each lead synchronously so we can collect a breakdown.
    const perCampaign = new Map<string, { count: number; totalScore: number }>();
    const skipReasons: Record<string, number> = {};
    const addedLeadIds: string[] = [];
    const addedLeadSummaries: Array<{ id: string; name: string; score: number; category: string | null; bio: string | null; reason: string | null }> = [];
    let leadsSkipped = 0;
    let regeneratedCount = 0;

    for (const lead of candidates) {
      const result = await step.run(`route-${lead.id}`, async (): Promise<AddLeadToCampaignResult> =>
        addLeadToCampaignCore({
          leadId: lead.id,
          campaignId: lead.suggested_campaign_id,
          softFail: true,
          markSkipped: true,
          regenerateDraftFirst,
        })
      );
      if (result.ok) {
        addedLeadIds.push(lead.id);
        if (result.regenerated) regeneratedCount += 1;
        addedLeadSummaries.push({
          id: lead.id,
          name: lead.full_name,
          score: lead.promotion_fit_score,
          category: lead.category,
          bio: lead.bio,
          reason: lead.suggested_campaign_reason,
        });
        const bucket = perCampaign.get(lead.suggested_campaign_id) || { count: 0, totalScore: 0 };
        bucket.count += 1;
        bucket.totalScore += lead.promotion_fit_score;
        perCampaign.set(lead.suggested_campaign_id, bucket);
      } else {
        leadsSkipped += 1;
        skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
      }
    }

    // Resolve campaign names for the digest breakdown
    const breakdown = await step.run('build-breakdown', async (): Promise<AutoAddRunBreakdownEntry[]> => {
      const ids = Array.from(perCampaign.keys());
      if (ids.length === 0) return [];
      const { data } = await supabase.from('campaigns').select('id, name').in('id', ids);
      const nameById = new Map((data || []).map((c: { id: string; name: string }) => [c.id, c.name]));
      return ids.map((id) => {
        const b = perCampaign.get(id)!;
        return {
          campaignId: id,
          campaignName: nameById.get(id) || 'Unknown campaign',
          count: b.count,
          avgFitScore: Math.round((b.totalScore / b.count) * 10) / 10,
        };
      }).sort((a, b) => b.count - a.count);
    });

    const backlogRemaining = await step.run('count-backlog', () =>
      countReadyToAddLeads(companyId, minFitScore)
    );

    // Digest only on the scheduled/manual sweep — catch-up fills quota without inbox noise.
    let digestSent = false;
    let digestError: string | null = null;
    if (addedLeadIds.length > 0 && trigger !== 'catchup') {
      const digestResult = await step.run('send-digest', async () => {
        const envRecipients = process.env.DIGEST_RECIPIENTS?.split(',').map((s) => s.trim()).filter(Boolean) || [];
        const recipients = company.auto_add_digest_email?.trim()
          ? [company.auto_add_digest_email.trim()]
          : envRecipients;
        if (recipients.length === 0) {
          return { sent: false, error: 'no_recipients' };
        }
        try {
          const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3200';
          const subject = `Autopilot · ${company.name} · ${addedLeadIds.length} lead${addedLeadIds.length === 1 ? '' : 's'} added`;
          await getResend().emails.send({
            from: process.env.DIGEST_FROM_EMAIL || 'autogtm <noreply@example.com>',
            to: recipients,
            subject,
            html: renderAutoAddDigestHtml({
              companyName: company.name,
              leadsAdded: addedLeadIds.length,
              leadsSkipped,
              breakdown,
              topLeads: addedLeadSummaries.slice(0, 5),
              skipReasons,
              backlogRemaining,
              minFitScore,
              dailyLimit,
              trigger,
              appUrl,
              regeneratedCount,
            }),
          });
          return { sent: true, error: null as string | null };
        } catch (e) {
          return { sent: false, error: e instanceof Error ? e.message : String(e) };
        }
      });
      digestSent = digestResult.sent;
      digestError = digestResult.error;
    }

    await step.run('complete-run', () =>
      completeAutoAddRun(run.id, {
        leads_considered: candidates.length,
        leads_added: addedLeadIds.length,
        leads_skipped: leadsSkipped,
        breakdown,
        added_lead_ids: addedLeadIds,
        skip_reasons: skipReasons,
        digest_sent: digestSent,
        digest_error: digestError,
      })
    );

    logger.info(`Autopilot sweep: company ${companyId} — added ${addedLeadIds.length}, regenerated ${regeneratedCount}, skipped ${leadsSkipped}, digest=${digestSent}`);
    return {
      runId: run.id,
      companyId,
      considered: candidates.length,
      added: addedLeadIds.length,
      regenerated: regeneratedCount,
      skipped: leadsSkipped,
      digestSent,
    };
  }
);

function renderAutoAddDigestHtml(params: {
  companyName: string;
  leadsAdded: number;
  leadsSkipped: number;
  breakdown: AutoAddRunBreakdownEntry[];
  topLeads: Array<{ id: string; name: string; score: number; category: string | null; bio: string | null; reason: string | null }>;
  skipReasons: Record<string, number>;
  backlogRemaining: number;
  minFitScore: number;
  dailyLimit: number;
  trigger: 'cron' | 'manual' | 'catchup';
  appUrl: string;
  regeneratedCount: number;
}): string {
  const { companyName, leadsAdded, leadsSkipped, breakdown, topLeads, skipReasons, backlogRemaining, minFitScore, dailyLimit, trigger, appUrl, regeneratedCount } = params;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const triggerLabel = trigger === 'manual' ? 'Manual run' : trigger === 'catchup' ? 'Catch-up run' : 'Daily run';

  const breakdownRows = breakdown.map((b) => `
    <tr>
      <td style="padding:10px 14px;border-top:1px solid #eee;font-size:14px;color:#111;">${esc(b.campaignName)}</td>
      <td style="padding:10px 14px;border-top:1px solid #eee;font-size:14px;color:#111;text-align:right;"><strong>${b.count}</strong></td>
      <td style="padding:10px 14px;border-top:1px solid #eee;font-size:14px;color:#666;text-align:right;">${b.avgFitScore.toFixed(1)}</td>
    </tr>
  `).join('');

  const topLeadsHtml = topLeads.map((l) => `
    <div style="padding:12px 0;border-top:1px solid #eee;">
      <div style="font-size:14px;color:#111;"><strong>${esc(l.name)}</strong> <span style="color:#999;">· fit ${l.score}/10${l.category ? ' · ' + esc(l.category) : ''}</span></div>
      ${l.bio ? `<div style="font-size:13px;color:#555;margin-top:4px;">${esc(l.bio.slice(0, 160))}${l.bio.length > 160 ? '…' : ''}</div>` : ''}
      ${l.reason ? `<div style="font-size:12px;color:#888;margin-top:4px;font-style:italic;">Why: ${esc(l.reason)}</div>` : ''}
    </div>
  `).join('');

  const skipReasonsHtml = Object.keys(skipReasons).length === 0
    ? ''
    : `<div style="margin-top:16px;padding:12px 14px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;font-size:13px;color:#9a3412;">
        <strong>Skipped ${leadsSkipped}:</strong>
        ${Object.entries(skipReasons).map(([r, n]) => `${n} × ${esc(r.replace(/_/g, ' '))}`).join(' · ')}
       </div>`;

  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
    <div style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <div style="background:#fff;border-radius:12px;border:1px solid #eee;overflow:hidden;">
        <div style="padding:24px 28px;background:linear-gradient(135deg,#10b981 0%,#059669 100%);color:#fff;">
          <div style="font-size:13px;opacity:.9;letter-spacing:.04em;text-transform:uppercase;">Autopilot · ${esc(triggerLabel)}</div>
          <div style="font-size:28px;font-weight:700;margin-top:6px;">${esc(companyName)}</div>
          <div style="font-size:16px;margin-top:10px;opacity:.95;">${leadsAdded} lead${leadsAdded === 1 ? '' : 's'} added to campaigns today</div>
        </div>

        <div style="padding:24px 28px;">
          <h3 style="margin:0 0 12px 0;font-size:14px;color:#666;font-weight:600;letter-spacing:.03em;text-transform:uppercase;">By campaign</h3>
          <table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:8px;overflow:hidden;">
            <thead>
              <tr style="background:#fafafa;">
                <th style="padding:10px 14px;text-align:left;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Campaign</th>
                <th style="padding:10px 14px;text-align:right;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Added</th>
                <th style="padding:10px 14px;text-align:right;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.04em;">Avg fit</th>
              </tr>
            </thead>
            <tbody>${breakdownRows}</tbody>
          </table>

          ${topLeads.length > 0 ? `
            <h3 style="margin:28px 0 8px 0;font-size:14px;color:#666;font-weight:600;letter-spacing:.03em;text-transform:uppercase;">Top picks</h3>
            <div>${topLeadsHtml}</div>
          ` : ''}

          ${skipReasonsHtml}

          ${regeneratedCount > 0 ? `
            <div style="margin-top:16px;padding:12px 14px;background:#eef2ff;border:1px solid #c7d2fe;border-radius:8px;font-size:13px;color:#3730a3;">
              Regenerated draft copy for <strong>${regeneratedCount}</strong> lead${regeneratedCount === 1 ? '' : 's'} before sending (fresh per-lead hooks).
            </div>
          ` : ''}

          <div style="margin-top:24px;padding:14px 16px;background:#f9fafb;border-radius:8px;font-size:13px;color:#555;">
            <strong style="color:#111;">${backlogRemaining}</strong> more Ready-to-Add leads in the queue at fit ≥ ${minFitScore}.
            Tomorrow's sweep will process up to ${dailyLimit}.
          </div>

          <div style="margin-top:24px;text-align:center;">
            <a href="${esc(appUrl)}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">View Dashboard</a>
          </div>
        </div>

        <div style="padding:16px 28px;border-top:1px solid #eee;font-size:12px;color:#999;">
          autogtm Autopilot · ${esc(companyName)}
        </div>
      </div>
    </div>
  </body>
</html>`;
}

// Export all functions
export const functions = [
  processWebsetRun,
  enrichLeadJob,
  addLeadToCampaignJob,
  dailyQueryGeneration,
  generateQueriesOnDemand,
  generateQueryForInstruction,
  dailyWebsetSearch,
  runCompanyWebsetSearch,
  dailyDigest,
  syncCampaignAnalytics,
  autoAddSweep,
  autoAddSweepCompany,
];
