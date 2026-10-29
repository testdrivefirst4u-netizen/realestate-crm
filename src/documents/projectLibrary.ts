/**
 * The Project Library the app shows and the AI searches: the company's saved copy (Admins edit it in the library's
 * "Edit" tab, stored by server/modules/library.ts) or, until one is saved, the library built into the app.
 * This file is the browser store; the content shape and the built-in library are in libraryContent.ts.
 */
import { useSyncExternalStore } from 'react';
import type { DocVerse, ProjectDocument } from './projectDocuments';
import { buildDocuments, defaultLibrary, type LibraryContent, type LibraryResponse } from './libraryContent';

export * from './libraryContent';

/* --------------------------------- store --------------------------------- */

export interface LibraryState {
  content: LibraryContent;
  documents: ProjectDocument[];
  verses: DocVerse[];
  /** The company saved its own library (false = the built-in one). */
  custom: boolean;
  updatedAt: string;
  updatedBy: string;
  loaded: boolean;
  /** This user may edit the library (an admin or a chosen library editor). */
  canEdit: boolean;
  /** Who else may edit it — known to admins only. */
  editors?: string[];
}

const stateFor = (content: LibraryContent | null, meta: Partial<LibraryState> = {}): LibraryState => {
  const c = content || defaultLibrary();
  const documents = buildDocuments(c);
  return { content: c, documents, verses: documents.flatMap((d) => d.verses), custom: !!content, updatedAt: '', updatedBy: '', loaded: false, canEdit: false, ...meta };
};

let state: LibraryState = stateFor(null);
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

export const projectLibrary = {
  get: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Use the content the server returned (`null` = built-in). */
  set(r: LibraryResponse) {
    state = stateFor(r.content, { updatedAt: r.updatedAt || '', updatedBy: r.updatedBy || '', loaded: true, canEdit: !!r.canEdit, editors: r.editors });
    listeners.forEach((l) => l());
  },
  /** Fetch the company's library (once; `force` again, e.g. when the library opens). Failures keep what is shown. */
  load(force = false): Promise<void> {
    if (loading) return loading;
    if (state.loaded && !force) return Promise.resolve();
    loading = import('../core/api')
      .then(({ api }) => api.library.get())
      .then((r) => projectLibrary.set(r))
      .catch(() => undefined)
      .finally(() => {
        loading = null;
      });
    return loading;
  },
};

export function useProjectLibrary(): LibraryState {
  return useSyncExternalStore(projectLibrary.subscribe, projectLibrary.get, projectLibrary.get);
}
