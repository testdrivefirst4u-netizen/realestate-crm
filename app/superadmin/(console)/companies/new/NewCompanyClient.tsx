'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type { CompanyDetail } from '@/server/platform/contract';
import { PageHeader, cx, focusRing } from '../../../_components/ui';
import { CreateCompanyForm } from './CreateCompanyForm';
import { CreatedPanel } from './CreatedPanel';

export function NewCompanyClient() {
  const [created, setCreated] = useState<{ company: CompanyDetail; adminEmail: string; password?: string } | null>(null);

  return (
    <>
      <PageHeader
        back={
          <Link href="/superadmin/companies" className={cx('inline-flex items-center gap-1.5 rounded text-[13.5px] font-medium text-[#6B6158] hover:text-[#1D2F3F]', focusRing)}>
            <ArrowLeft className="h-4 w-4" aria-hidden /> Companies
          </Link>
        }
        title={created ? 'Company created' : 'New company'}
        description={created ? undefined : 'Provision a new CRM workspace and its first administrator.'}
      />
      {created ? (
        <CreatedPanel company={created.company} adminEmail={created.adminEmail} password={created.password} onCreateAnother={() => setCreated(null)} />
      ) : (
        <CreateCompanyForm onCreated={(company, adminEmail, password) => setCreated({ company, adminEmail, password })} />
      )}
    </>
  );
}
