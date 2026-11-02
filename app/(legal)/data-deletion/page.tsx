import type { Metadata } from 'next';
import Link from 'next/link';
import { legalDetails } from '../legal';

/** Details come from the database (Super admin › Settings › Branding & legal). */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const LEGAL = await legalDetails();
  return { title: 'Data Deletion', description: `How to delete your data from ${LEGAL.product}, including data received from Facebook, Instagram, Google, LinkedIn or Pinterest.` };
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
        Facebook, Instagram, Google, LinkedIn or Pinterest.
      </p>

      <h2>If you submitted a lead form, or commented on or messaged a business page</h2>
      <ol>
        <li>
          E-mail <a href={`mailto:${email}?subject=Data%20deletion%20request`}>{email}</a> with the subject <strong>&ldquo;Data deletion request&rdquo;</strong>.
        </li>
        <li>
          Include the phone number and/or e-mail address you entered, or your Facebook, Instagram, LinkedIn or Pinterest name for a comment or message,
          and the name of the business.
        </li>
        <li>We delete the matching lead records, messages, comments and their history within 30 days and confirm by e-mail.</li>
      </ol>
      <p>
        You can also remove the business&rsquo;s access from Facebook itself: <strong>Settings &amp; privacy → Settings → Business integrations</strong>{' '}
        (or <strong>Apps and websites</strong>), then remove the app. This stops new data being shared; to delete data already received, send the
        request above.
      </p>

      <h2>If you connected a page or account to the CRM</h2>
      <ol>
        <li>
          In the CRM, go to <strong>Settings</strong>, open the connected Facebook Page, Instagram account, Google, LinkedIn or Pinterest account and click{' '}
          <strong>Disconnect</strong>. Its access token is deleted immediately and no further data is received.
        </li>
        <li>You can also remove the app from the platform itself (for Facebook: <strong>Business integrations</strong>; for Google: <strong>Google Account → Security → Third-party connections</strong>).</li>
        <li>
          To delete the data that already came from that account as well (leads, messages, comments, reviews, post statistics), e-mail us from the
          company&rsquo;s registered address and we will remove it within 30 days.
        </li>
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
