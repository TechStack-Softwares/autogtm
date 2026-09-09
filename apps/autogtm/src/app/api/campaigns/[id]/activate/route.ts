import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { activateCampaign } from '@autogtm/core/clients/instantly';
import { sendDraftCampaignForLead } from '@autogtm/core/campaigns/createCampaignForPersona';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const supabase = createAdminClient();

    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select('id, source_lead_id, instantly_campaign_id, status')
      .eq('id', id)
      .single();

    if (error || !campaign) {
      return NextResponse.json({ error: 'Campaign not found' }, { status: 404 });
    }

    if (!campaign.instantly_campaign_id) {
      if (!campaign.source_lead_id) {
        return NextResponse.json({ error: 'Draft campaign has no source lead' }, { status: 400 });
      }

      await sendDraftCampaignForLead({
        campaignId: campaign.id,
        leadId: campaign.source_lead_id,
      });
      return NextResponse.json({ success: true });
    }

    await activateCampaign(campaign.instantly_campaign_id);

    await supabase
      .from('campaigns')
      .update({ status: 'active', updated_at: new Date().toISOString() })
      .eq('id', id);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error activating campaign:', error);
    return NextResponse.json({ error: 'Failed to activate campaign' }, { status: 500 });
  }
}
