/** Shared by the planner and the composer of the post scheduler. */
import { type PostTargetKind, type SocialPost } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';

export const KIND: Record<PostTargetKind, { label: string; cls: string }> = {
  facebook: { label: 'Facebook', cls: 'bg-[#1877F2]' },
  instagram: { label: 'Instagram', cls: 'bg-gradient-to-br from-[#F58529] via-[#DD2A7B] to-[#8134AF]' },
  google: { label: 'Google', cls: 'bg-[#34A853]' },
  linkedin: { label: 'LinkedIn', cls: 'bg-[#0A66C2]' },
  pinterest: { label: 'Pinterest', cls: 'bg-[#E60023]' },
};
export const STATUS: Record<SocialPost['status'], { label: string; tone: 'sage' | 'amber' | 'rust' | 'muted' | 'navy' }> = {
  draft: { label: 'Draft', tone: 'muted' }, scheduled: { label: 'Scheduled', tone: 'navy' }, publishing: { label: 'Posting…', tone: 'amber' }, published: { label: 'Posted', tone: 'sage' }, partial: { label: 'Partly posted', tone: 'amber' }, failed: { label: 'Failed', tone: 'rust' },
};
export const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
export const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
/** When a post went out (or will). */
export const postDate = (p: SocialPost) => new Date(p.status === 'scheduled' || p.status === 'draft' ? p.scheduledAt : p.publishedAt || p.scheduledAt);
