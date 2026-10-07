import type { Metadata } from 'next';
import Link from 'next/link';
import { legalDetails } from '../legal';

/** Details come from the database (Super admin › Settings › Branding & legal). */
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  const LEGAL = await legalDetails();
  return { title: 'Terms of Service', description: `The terms for using ${LEGAL.product}.` };
}

export default async function TermsPage() {
  const LEGAL = await legalDetails();
  const { company, product, email, address, jurisdiction, updated } = LEGAL;
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="updated">Last updated: {updated}</p>

      <p>
        These terms govern the use of {product} (&ldquo;the CRM&rdquo;), operated by {company} (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By signing in or using the
        CRM you agree to them. If you use the CRM on behalf of a business (&ldquo;the company&rdquo;), you confirm you are allowed to accept these terms for it.
      </p>

      <h2>1. The service</h2>
      <p>
        The CRM lets real-estate teams record and manage leads, follow-ups, tasks, inventory and reports, and receive leads from website forms,
        Google Sheets, Facebook and Instagram Lead Ads and other connected services. Features available to a company depend on its plan.
      </p>

      <h2>2. Accounts</h2>
      <ul>
        <li>Accounts are created by the company&rsquo;s administrator or by us. Keep your password confidential; you are responsible for activity under your account.</li>
        <li>Tell your administrator or us straight away if you suspect unauthorised access.</li>
        <li>We may suspend an account or company that breaks these terms or puts the service or other users at risk.</li>
      </ul>

      <h2>3. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Record or contact people without a lawful basis, or send spam or unsolicited messages in breach of applicable law (including telemarketing and do-not-call rules).</li>
        <li>Upload unlawful content, malware, or data you have no right to use.</li>
        <li>Try to access other companies&rsquo; data, probe or disrupt the service, or get around its security or plan limits.</li>
        <li>Resell or share access to the CRM outside your company without our written permission.</li>
      </ul>

      <h2>4. Your data</h2>
      <ul>
        <li>The company owns the lead and business data it puts into the CRM, and is responsible for having the right to collect and use it.</li>
        <li>We process that data only to provide the service, as described in our <Link href="/privacy">Privacy Policy</Link>.</li>
        <li>A company can export its leads at any time, and ask us to delete its account and data.</li>
      </ul>

      <h2>5. Connected services</h2>
      <p>
        When a company connects Facebook or Instagram, Google, Chat360, a telephony provider or another service, its use of that service is also
        subject to that provider&rsquo;s terms. The company must have the necessary rights to the Pages, sheets and accounts it connects. We are not
        responsible for outages or changes made by those providers.
      </p>

      <h2>6. Plans and fees</h2>
      <p>Plans, user limits and fees are agreed with each company. Features outside a company&rsquo;s plan are not available to it.</p>

      <h2>7. Availability</h2>
      <p>
        We work to keep the CRM available and secure, but it is provided &ldquo;as is&rdquo; and we do not guarantee it will be uninterrupted or error-free.
        We may change or improve features over time.
      </p>

      <h2>8. Liability</h2>
      <p>
        To the extent permitted by law, we are not liable for indirect or consequential losses, lost profits or lost business, and our total
        liability for any claim is limited to the fees the company paid us in the three months before the claim.
      </p>

      <h2>9. Ending use</h2>
      <p>
        A company may stop using the CRM at any time. We may suspend or end access for breach of these terms or non-payment. On request after
        termination, we will delete the company&rsquo;s data as described in the <Link href="/data-deletion">Data deletion</Link> page.
      </p>

      <h2>10. Changes to these terms</h2>
      <p>We may update these terms. The date above shows the latest version; continuing to use the CRM after a change means you accept it.</p>

      <h2>11. Governing law</h2>
      <p>These terms are governed by the laws of India. The courts of {jurisdiction} have exclusive jurisdiction.</p>

      <h2>12. Contact</h2>
      <p>
        {company}, {address}. E-mail: <a href={`mailto:${email}`}>{email}</a>.
      </p>
    </>
  );
}
