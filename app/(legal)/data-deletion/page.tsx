import type { Metadata } from 'next';
import Link from 'next/link';
import { legalDetails } from '../legal';

/** Details come from the database (Super admin › Settings › Branding & legal). */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const LEGAL = await legalDetails();
  return { title: 'Data Deletion', description: `How to delete your data from ${LEGAL.product}, including data received from Facebook.` };
}

export default async function DataDeletionPage() {
  const LEGAL = await legalDetails();
  const { company, product, email, updated } = LEGAL;
  return (
    <>
      <h1>Data Deletion Instructions</h1>
      <p className="updated">Last updated: {updated}</p>

      <p>
        You can ask for your personal data to be deleted from {product} at any time. This page explains how, including for data we received through
        Facebook or Instagram Lead Ads.
      </p>

      <h2>If you submitted a Facebook or Instagram lead form</h2>
      <ol>
        <li>
          E-mail <a href={`mailto:${email}?subject=Data%20deletion%20request`}>{email}</a> with the subject <strong>&ldquo;Data deletion request&rdquo;</strong>.
        </li>
        <li>Include the phone number and/or e-mail address you entered in the form, and the name of the business you enquired with.</li>
        <li>We delete the matching lead records and their history within 30 days and confirm by e-mail.</li>
      </ol>
      <p>
        You can also remove the business&rsquo;s access from Facebook itself: <strong>Settings &amp; privacy → Settings → Business integrations</strong>{' '}
        (or <strong>Apps and websites</strong>), then remove the app. This stops new data being shared; to delete data already received, send the
        request above.
      </p>

      <h2>If you connected a Facebook Page to the CRM</h2>
      <ol>
        <li>In the CRM, go to <strong>Settings → Lead sources</strong>, open the Page and click <strong>Disconnect</strong>. The Page access token is deleted immediately and no further leads are received.</li>
        <li>To delete the leads that came from that Page as well, delete them in the CRM or e-mail us and we will remove them.</li>
      </ol>

      <h2>If you are a CRM user</h2>
      <ul>
        <li>Your company administrator can remove your account in <strong>Settings → Users &amp; roles</strong>.</li>
        <li>To delete an entire company workspace and all of its data, the company&rsquo;s owner can e-mail us; the company&rsquo;s database is deleted permanently.</li>
      </ul>

      <h2>What is kept</h2>
      <p>
        Records we must keep by law (for example invoices) are kept only for the required period. Backups are overwritten in the normal backup cycle.
        See the <Link href="/privacy">Privacy Policy</Link> for details.
      </p>

      <h2>Contact</h2>
      <p>
        {company} · <a href={`mailto:${email}`}>{email}</a>
      </p>
    </>
  );
}
