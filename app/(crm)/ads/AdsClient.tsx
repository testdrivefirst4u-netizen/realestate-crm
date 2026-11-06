'use client';

import { AdsView } from '@/src/modules/ads/AdsView';
import { useCrm } from '../_components/CrmShell';

export function AdsClient() {
  const { engine } = useCrm();
  return <AdsView canChange={engine.can('marketing.ads')} />;
}
