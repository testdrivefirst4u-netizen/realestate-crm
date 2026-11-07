import type { Metadata } from 'next';
import { WhatsappCreditsClient } from './WhatsappCreditsClient';

export const metadata: Metadata = { title: 'WhatsApp credits' };

export default function WhatsappCreditsPage() {
  return <WhatsappCreditsClient />;
}
