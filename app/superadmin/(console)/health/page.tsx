import type { Metadata } from 'next';
import { HealthClient } from './HealthClient';

export const metadata: Metadata = { title: 'Platform health' };

export default function HealthPage() {
  return <HealthClient />;
}
