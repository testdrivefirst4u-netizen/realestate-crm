import type { Metadata } from 'next';
import Link from 'next/link';
import { legalDetails } from '../legal';

/** Details come from the database (Super admin › Settings › Branding & legal). */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const LEGAL = await legalDetails();
  return { title: 'Privacy Policy', description: `How ${LEGAL.product} collects, uses and protects personal data.` };
}

export default async function PrivacyPage() {
  const LEGAL = await legalDetails();
  const { company, product, email, address, updated } = LEGAL;
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="updated">Last updated: {updated}</p>

      <p>
        {product} (&ldquo;the CRM&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) is a sales CRM for real-estate teams, operated by {company}. This policy explains what
        personal data the CRM processes, why, and the choices you have. It applies to the people who use the CRM (company staff) and to the
        prospective customers (&ldquo;leads&rdquo;) whose enquiries are recorded in it.
      </p>

      <h2>1. Who is responsible</h2>
      <p>
        Each business that uses the CRM (&ldquo;a company&rdquo;) decides which leads it records and how it contacts them; for that lead data the company is
        the data controller and we process it on its behalf. For the accounts of CRM users and for running the platform, {company} is
        responsible. Contact: <a href={`mailto:${email}`}>{email}</a>, {address}.
      </p>

      <h2>2. Data we process</h2>
      <h3>CRM users</h3>
      <ul>
        <li>Name, e-mail address, role, optional profile photo and the company you belong to.</li>
        <li>Your password, stored only as a one-way hash (bcrypt); we cannot read it.</li>
        <li>Sign-in records (time, IP address, browser) and an audit log of changes you make, kept for security.</li>
      </ul>
      <h3>Leads (prospective customers)</h3>
      <ul>
        <li>Contact details: name, phone number, e-mail address.</li>
        <li>Enquiry details: property or unit type of interest, budget, source of the enquiry, messages, notes, follow-ups, site visits and bookings.</li>
        <li>Campaign information that arrives with an enquiry, such as the ad, campaign, form or page it came from.</li>
        <li>Where a company uses these features: WhatsApp conversations (through Chat360), call logs and call recordings, and uploaded documents.</li>
      </ul>

      <h2>3. Where lead data comes from</h2>
      <ul>
        <li><strong>Entered by company staff</strong> or imported from a file.</li>
        <li><strong>Website forms and webhooks</strong> that a company connects with its own API key.</li>
        <li>
          <strong>Google Sheets</strong> that a company shares with the CRM. When a company uses &ldquo;Connect with Google&rdquo;, we receive an access token for
          Google Sheets only (scope <em>spreadsheets</em>), used solely to read and write the sheets that company links.
        </li>
        <li>
          <strong>Facebook and Instagram Lead Ads</strong> (Meta). When a company admin connects a Facebook Page, we receive a Page access token and, for
          each lead form submission on that Page, the answers the person entered in the form plus the ad, campaign and form it came from. We use
          this only to create the lead in that company&rsquo;s CRM. We do not use Facebook data for advertising, do not sell it, and do not combine it
          with data from other companies.
        </li>
        <li><strong>WhatsApp (Chat360) and telephony providers</strong> that a company connects, for messages and calls with its leads.</li>
      </ul>

      <h2>4. Why we use the data</h2>
      <ul>
        <li>To provide the CRM: store and organise leads, assign them to team members, schedule follow-ups and show reports.</li>
        <li>To sign you in and keep accounts secure (session management, sign-in throttling, audit log).</li>
        <li>To send notifications a company has switched on, such as follow-up reminders and a daily digest e-mail.</li>
        <li>
          Optional AI features (summaries, rewriting, transcription) send the relevant text or audio to Google&rsquo;s Gemini API to produce the result. They
          run only when a company has enabled them and a user asks for them.
        </li>
      </ul>
      <p>We do not sell personal data and do not use it for advertising.</p>

      <h2>5. Who we share it with</h2>
      <p>Only with the service providers needed to run the CRM, each bound to protect the data:</p>
      <ul>
        <li>Vercel (application hosting) and MongoDB Atlas on AWS in Mumbai, India (database and file storage).</li>
        <li>Meta, Google, Chat360 and telephony providers, only when a company connects them, to exchange the data described above.</li>
        <li>Google (Gemini API), only when AI features are used.</li>
        <li>An e-mail provider, to deliver notification e-mails.</li>
      </ul>
      <p>We may also disclose data when required by law.</p>

      <h2>6. How we protect it</h2>
      <ul>
        <li>Each company&rsquo;s data is kept in its own separate database.</li>
        <li>All connections use HTTPS. API keys, Facebook and Google tokens and other secrets are stored encrypted (AES-256-GCM).</li>
        <li>Sessions use secure, http-only cookies that expire after 12 hours of inactivity.</li>
        <li>Access inside a company is limited by role (for example, a relationship manager sees only their own leads unless allowed otherwise).</li>
      </ul>

      <h2>7. How long we keep it</h2>
      <ul>
        <li>Lead and account data: for as long as the company uses the CRM, or until it is deleted.</li>
        <li>Records of incoming form, webhook and Facebook submissions: 180 days.</li>
        <li>When a company account is deleted, its entire database is deleted.</li>
      </ul>

      <h2>8. Cookies and local storage</h2>
      <p>
        We use one essential cookie to keep you signed in, and short-lived cookies during Google or Facebook connection to protect against forged
        requests. Your browser also stores display preferences (such as layout settings) locally. We do not use advertising or tracking cookies.
      </p>

      <h2>9. Your rights</h2>
      <p>
        You can ask to access, correct or delete your personal data, or object to its use. If you are a lead, contact the business you enquired
        with, or write to us and we will pass your request to that business. See <Link href="/data-deletion">Data deletion</Link> for how to remove
        data, including data received from Facebook.
      </p>

      <h2>10. Children</h2>
      <p>The CRM is a business tool and is not intended for anyone under 18.</p>

      <h2>11. Changes</h2>
      <p>We may update this policy. The date at the top shows the latest version; significant changes will be announced in the CRM.</p>

      <h2>12. Contact</h2>
      <p>
        {company}, {address}. E-mail: <a href={`mailto:${email}`}>{email}</a>.
      </p>
    </>
  );
}
