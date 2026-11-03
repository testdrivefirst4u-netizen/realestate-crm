import type { Metadata } from 'next';
import { requireView } from '@/server/core/pageSession';
import { VIEW_TITLES } from '@/src/core/views';
import { PostsClient } from './PostsClient';

export const metadata: Metadata = { title: VIEW_TITLES.posts };

export default async function PostsPage() {
  await requireView('posts');
  return <PostsClient />;
}
