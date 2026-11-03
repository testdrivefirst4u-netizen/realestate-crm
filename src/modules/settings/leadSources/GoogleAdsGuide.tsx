/**
 * Setup of a Google Ads lead source: the webhook URL and key to type into the lead form's "Webhook integration"
 * (server: app/api/webhooks/google-ads/route.ts). The key is only known right after it is made or regenerated.
 */
import React, { useEffect, useState } from 'react';
import { CopyButton } from './IntegrationGuide';
import { KEY_PLACEHOLDER } from './leadSourceUtils';

export const GOOGLE_ADS_PATH = '/api/webhooks/google-ads';

export const GoogleAdsGuide: React.FC<{ apiKey?: string }> = ({ apiKey }) => {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const url = `${origin}${GOOGLE_ADS_PATH}`;
  const row = (label: string, value: string, note?: string) => (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[#5E778C] mb-1">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="flex-1 min-w-0 break-all rounded-lg border border-[#D3E3F0] bg-white px-3 py-2 text-xs text-[#0B2A44]">{value}</code>
        {value !== KEY_PLACEHOLDER && <CopyButton value={value} ariaLabel={`Copy ${label}`} />}
      </div>
      {note && <p className="text-[11px] text-[#7E93A6] mt-1">{note}</p>}
    </div>
  );
  return (
    <div className="space-y-4 text-xs text-[#2B4A63]">
      {row('Webhook URL', url)}
      {row('Key', apiKey || KEY_PLACEHOLDER, apiKey ? 'Shown only now. Paste it into Google Ads before closing.' : 'The key is shown only when it is made. Lost it? Use “Regenerate key” and paste the new one into every lead form.')}
      <ol className="list-decimal pl-5 space-y-1.5">
        <li>In Google Ads, open <b>Campaigns → Assets</b> (or <b>Tools → Assets</b>) and choose <b>Lead forms</b>.</li>
        <li>Open the lead form (edit it) and scroll to <b>Lead delivery option</b> → <b>Webhook integration</b>.</li>
        <li>Paste the <b>Webhook URL</b> and the <b>Key</b> above, then click <b>Send test data</b>. Google should show “success”.</li>
        <li>The test appears in this source’s <b>Intake log</b> as “test lead: received correctly”. Tests are not added as leads.</li>
        <li>Save the form. Do this for each lead form; they can all use the same URL and key.</li>
      </ol>
      <p className="text-[#5E778C]">Real leads arrive within seconds of the form being submitted, with the same RM assignment, duplicate and re-enquiry rules as your other sources. Google sends campaign and form IDs (not names), so leads show “Google Ads campaign 123…” as the campaign.</p>
    </div>
  );
};
