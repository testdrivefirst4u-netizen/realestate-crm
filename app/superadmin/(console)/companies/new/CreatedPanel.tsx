'use client';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, Plus } from 'lucide-react';
import type { CompanyDetail } from '@/server/platform/contract';
import { CopyRow, TempPasswordPanel } from '../../../_components/SecretPanel';
import { Button, Card, LinkButton } from '../../../_components/ui';

export function CreatedPanel({
  company,
  adminEmail,
  password,
  onCreateAnother,
}: {
  company: CompanyDetail;
  adminEmail: string;
  password?: string;
  onCreateAnother: () => void;
}) {
  const [origin, setOrigin] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    setOrigin(window.location.origin);
    headingRef.current?.focus();
  }, []);
  const signInUrl = `${origin}/`;

  return (
    <Card className="max-w-2xl">
      <div className="flex items-start gap-3 border-b border-[#EFE9E2] px-5 py-4">
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#067647]" aria-hidden />
        <div>
          <h2 ref={headingRef} tabIndex={-1} className="text-[15px] font-semibold outline-none">
            {company.name} is ready
          </h2>
          <p className="mt-0.5 text-[13.5px] text-[#6B6158]">
            Workspace <span className="font-mono">{company.slug}</span> ({company.id}) was created with its first administrator. Share these sign-in details with them.
          </p>
        </div>
      </div>
      <div className="space-y-4 px-5 py-5">
        {password ? (
          <TempPasswordPanel email={adminEmail} password={password} />
        ) : (
          <>
            <CopyRow label="Administrator e-mail" value={adminEmail} mono={false} />
            <p className="rounded-lg border border-[#E4DCD2] bg-[#FBF9F6] px-3.5 py-3 text-[13.5px] text-[#4A423B]">
              The administrator signs in with the password you set on the form.
            </p>
          </>
        )}
        {origin && <CopyRow label="CRM sign-in URL" value={signInUrl} />}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-[#EFE9E2] bg-[#FBF9F6] px-5 py-3 rounded-b-xl">
        <Button variant="secondary" icon={<Plus className="h-4 w-4" aria-hidden />} onClick={onCreateAnother}>
          Create another
        </Button>
        <LinkButton href={`/superadmin/companies/${encodeURIComponent(company.id)}`} icon={<ArrowRight className="h-4 w-4" aria-hidden />}>
          Open company
        </LinkButton>
      </div>
    </Card>
  );
}
