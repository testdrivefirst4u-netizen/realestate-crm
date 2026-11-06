/**
 * Post scheduler › delete a published post from the platforms chosen. It cannot be undone there, so it asks; the copy stays
 * in the CRM, marked Deleted. If a platform refuses, that account stays as it was and the reason shows here.
 */
import React, { useState } from 'react';
import { ExternalLink, Trash2 } from 'lucide-react';
import { api, type SocialPost } from '../../core/api';
import { toast } from '../../core/notifications';
import { Button, InlineNotice, Modal } from '../../components/ui';
import { KIND, errText } from './postShared';

const DELETABLE = ['facebook', 'instagram', 'google'];
export const deletableTargets = (p: SocialPost) => p.targets.filter((t) => t.status === 'posted' && !!t.postId && DELETABLE.includes(t.kind));

export const PostDeleteDialog: React.FC<{ post: SocialPost; onClose: () => void; onDone: (post: SocialPost) => void }> = ({ post, onClose, onDone }) => {
  const targets = deletableTargets(post);
  const others = post.targets.filter((t) => t.status === 'posted' && !DELETABLE.includes(t.kind));
  const [keys, setKeys] = useState<string[]>(targets.map((t) => t.key));
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Array<{ name: string; error: string; url: string }>>([]);
  const carousel = post.imageFileIds.length > 1 || post.imageUrls.length > 1;

  const submit = async () => {
    setBusy(true);
    setFailed([]);
    try {
      const r = await api.posts.deletePublished(post.id, keys);
      if (r.deleted.length) toast('Post deleted', `Removed from ${r.deleted.join(', ')}.`, 'success');
      if (r.alreadyGone.length) toast('Already deleted on the platform', `${r.alreadyGone.join(', ')} no longer has this post, so the CRM now shows it as deleted.`, 'success');
      if (r.failed.length) {
        setFailed(r.failed);
        setKeys(r.failed.map((f) => f.key));
        setSure(false);
        return; // stays open with the reason; what was removed is already saved
      }
      onDone(r.post);
    } catch (e) {
      toast('Not deleted', errText('posts.deletePublished', e), 'alert');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Delete this post from" width="sm" footer={
      <>
        <Button variant="secondary" onClick={onClose}>{failed.length ? 'Close' : 'Cancel'}</Button>
        <Button variant="danger" icon={<Trash2 size={13} />} loading={busy} disabled={!keys.length || !sure} onClick={() => void submit()}>Delete</Button>
      </>
    }>
      <div className="space-y-3 text-xs text-[#1C2B33]">
        {failed.map((f) => <InlineNotice key={f.name} tone="warning">{f.name} is still there. {f.error}{f.url && <> <a href={f.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold underline">Open the post <ExternalLink size={11} /></a></>}</InlineNotice>)}
        {post.imported && keys.some((k) => k.startsWith('facebook:')) && !failed.length && <p className="text-[#65676B]">This post was copied in from Facebook. Facebook may refuse to delete a post that wasn't published through the CRM. If it does, you'll get a link to delete it there.</p>}
        <ul className="space-y-1.5">
          {targets.map((t) => (
            <li key={t.key}>
              <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                <input type="checkbox" className="h-4 w-4 accent-[#0866FF]" checked={keys.includes(t.key)} onChange={(e) => setKeys((k) => (e.target.checked ? [...k, t.key] : k.filter((x) => x !== t.key)))} />
                <span className={`h-2.5 w-2.5 flex-none rounded-full ${KIND[t.kind].cls}`} />
                <span className="min-w-0 break-words">{KIND[t.kind].label}: {t.name}</span>
              </label>
            </li>
          ))}
        </ul>
        {others.length > 0 && <p className="text-[#65676B]">{others.map((t) => t.name).join(', ')} can only be removed on the platform itself.</p>}
        {carousel && keys.some((k) => k.startsWith('instagram:')) && <p className="text-[#65676B]">On Instagram the whole carousel is removed, not single photos.</p>}
        <div className="rounded-lg border border-[#F5C2B8] bg-[#FEF3F2] p-3">
          <p>This cannot be undone. Its likes, comments and shares on those accounts are lost too. A copy stays here, marked Deleted.</p>
          <label className="mt-2 flex items-start gap-2 font-semibold"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#B42318]" checked={sure} onChange={(e) => setSure(e.target.checked)} />I want to delete it</label>
        </div>
      </div>
    </Modal>
  );
};
