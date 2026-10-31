/**
 * The Project Library: every project document (brochure, floor plans, packages, prices, legal papers and the files
 * the team adds) split into numbered passages, so any word or figure can be found and quoted.
 *
 * Layout: a side menu (Search · Documents · Quick facts · Edit) with the documents listed under it; on phones the
 * menu becomes a row of tabs. Admins and the chosen library editors can add PDF / Word / Excel files and edit.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, BookOpen, Building, Check, ChevronLeft, ChevronRight, Copy, DollarSign, Download, FileText,
  HeartHandshake, Library, MapPin, Pencil, Search, Share2, ShieldCheck, Sparkles, Upload, X,
} from 'lucide-react';
import { DocVerse, searchProjectConcordance, SearchMatch, highlightTerms } from '../documents/projectDocuments';
import { projectLibrary, useProjectLibrary } from '../documents/projectLibrary';
import { LibraryEditor } from './LibraryEditor';
import { FileKindIcon, LibraryUpload } from './LibraryUpload';
import { cx } from './ui';

interface LibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialQuery?: string;
  /** Admins may edit the library (documents, passages, quick specs); so may the chosen library editors. */
  canEdit?: boolean;
}

type Tab = 'search' | 'documents' | 'reader' | 'facts' | 'edit';

const SECTION_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  building: Building, shield: ShieldCheck, money: DollarSign, heart: HeartHandshake, sparkles: Sparkles, map: MapPin, book: BookOpen, file: FileText,
};

const POPULAR = ['MediCiti', '1,533', '2.5 BHK', 'Vaastu', 'Vegetarian', 'TG RERA', 'Ambulance', 'Milestones', 'BSP ₹8,999', 'Kandlakoya', 'Escrow', 'Buggy'];

/** Escaped HTML of `text` with `q` (user input) highlighted — see highlightTerms. */
const highlightText = (text: string, q: string): string => highlightTerms(text, q ? [q] : []);

/** Prices, sizes, distances, times and counts in bold, so a fact card can be read at a glance. */
const KEY_NUMBER = /(₹\s?[\d,.]+(?:\s?(?:L|Lakh|Lakhs|Cr|Crore|crore|lakh))?(?:\s?[–-]\s?₹?\s?[\d,.]+(?:\s?(?:L|Lakh|Lakhs|Cr|Crore|crore|lakh))?)?|\d[\d,.]*(?:\s?[–-]\s?\d[\d,.]*)?\s?(?:sq\.?\s?ft\.?|sft|km|mins?|%|BHK|acres?|floors?|units?|years?|months?|days?|lifts?)(?![A-Za-z]))/g;
function emphasise(text: string): React.ReactNode {
  const parts = text.split(KEY_NUMBER);
  return parts.map((p, i) => (i % 2 ? <b key={i} className="font-semibold text-[#0B2A44]">{p}</b> : p));
}

/** "Kukatpally (Locality) — west side · about 25–30 km from Amaya · 35–50 min by car" → its parts. */
const LOCATION_LINE = /^(.+?) \((.+?)\) — (?:.*?)about (.+?) km from Amaya · (.+?) min by car$/;

/** ".pdf" — from the document's file name, else from its download link. */
function extensionOf(fileName: string, url: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(fileName || '') || /\.([A-Za-z0-9]+)(?:[?#].*)?$/.exec(url || '');
  return m ? m[1].toUpperCase() : '';
}

/** The name a download is saved as. */
function downloadName(fileName: string, url: string): string {
  if (fileName) return fileName;
  const seg = String(url || '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

const CATEGORY_TONE: Record<string, string> = {
  'Brochure': 'bg-sky-50 text-sky-800 border-sky-200',
  'Floor Plans': 'bg-violet-50 text-violet-800 border-violet-200',
  'Monthly Packages': 'bg-emerald-50 text-emerald-800 border-emerald-200',
  'Pricing & Payment': 'bg-amber-50 text-amber-800 border-amber-200',
  'Legal & RERA': 'bg-rose-50 text-rose-800 border-rose-200',
  'Locations': 'bg-teal-50 text-teal-800 border-teal-200',
};
const CategoryPill: React.FC<{ category: string }> = ({ category }) => (
  <span className={cx('inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold border whitespace-nowrap', CATEGORY_TONE[category] || 'bg-[#F2F7FB] text-[#5E778C] border-[#D3E3F0]')}>{category}</span>
);

const IconBtn: React.FC<{ title: string; onClick: () => void; children: React.ReactNode; tone?: 'green' }> = ({ title, onClick, children, tone }) => (
  <button
    type="button"
    onClick={onClick}
    title={title}
    aria-label={title}
    className={cx('p-1.5 rounded-lg border transition', tone === 'green' ? 'text-emerald-700 border-emerald-200 hover:bg-emerald-50' : 'text-[#5E778C] border-[#D3E3F0] hover:text-[#0B2A44] hover:bg-[#F2F7FB]')}
  >
    {children}
  </button>
);

export const LibraryModal: React.FC<LibraryModalProps> = ({ isOpen, onClose, initialQuery = '', canEdit: isAdmin = false }) => {
  const lib = useProjectLibrary();
  // admins, plus the people an admin chose as library editors (the server says which)
  const canEdit = isAdmin || lib.canEdit;
  const documents = lib.documents;
  const [tab, setTab] = useState<Tab>('search');
  const [searchTerm, setSearchTerm] = useState(initialQuery);
  const [docFilter, setDocFilter] = useState('all');
  const [matchMode, setMatchMode] = useState<'any' | 'phrase' | 'all'>('any');
  const [showUpload, setShowUpload] = useState(false);
  /** The editor has changes not saved yet. */
  const [editing, setEditing] = useState(false);

  // reader
  const [readerDocId, setReaderDocId] = useState('');
  const [readerChapter, setReaderChapter] = useState(1);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const highlightedRef = useRef<HTMLDivElement | null>(null);
  const readerTop = useRef<HTMLDivElement | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** Documents open as fact cards (every section on one page) or section by section. */
  const [readMode, setReadMode] = useState<'cards' | 'sections'>(() => {
    try { return localStorage.getItem('libraryReadMode') === 'sections' ? 'sections' : 'cards'; } catch { return 'cards'; }
  });
  const chooseReadMode = (m: 'cards' | 'sections') => {
    setReadMode(m);
    try { localStorage.setItem('libraryReadMode', m); } catch { /* private window */ }
  };
  const [activeSection, setActiveSection] = useState(1);
  const goToSection = (n: number) => {
    setHighlightId(null);
    if (readMode === 'sections') return setReaderChapter(n);
    setActiveSection(n);
    try { document.getElementById(`libsec-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* old browsers */ }
  };

  // the company's latest library each time it opens
  useEffect(() => {
    if (isOpen) void projectLibrary.load(true);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    setSearchTerm(initialQuery);
    if (initialQuery.trim()) setTab('search');
  }, [isOpen, initialQuery]);

  const close = () => {
    if (editing && !window.confirm('Close without saving your library changes?')) return;
    setEditing(false);
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen]);

  // a document filter that no longer exists (removed in the editor) goes back to all documents
  useEffect(() => {
    if (docFilter !== 'all' && !documents.some((d) => d.id === docFilter)) setDocFilter('all');
  }, [documents, docFilter]);

  const q = searchTerm.trim().toLowerCase();
  const matches: SearchMatch[] = useMemo(() => (q ? searchProjectConcordance(q, docFilter, matchMode, lib.verses) : []), [q, docFilter, matchMode, lib.verses]);
  const facts = useMemo(() => lib.content.sections.map((s) => ({ ...s, Icon: SECTION_ICON[s.icon] || FileText })), [lib.content.sections]);
  const matchingFacts = useMemo(
    () => (q ? facts.map((s) => ({ ...s, items: s.items.filter((i) => i.toLowerCase().includes(q) || s.category.toLowerCase().includes(q)) })).filter((s) => s.items.length) : facts),
    [q, facts],
  );

  const readerDoc = documents.find((d) => d.id === readerDocId) || documents[0];
  const chapter = readerDoc?.chapters.find((c) => c.chapterNumber === readerChapter) || readerDoc?.chapters[0];

  // "Open in document": bring the passage into view once the reader shows it; otherwise start at the top
  useEffect(() => {
    if (!isOpen || tab !== 'reader') return;
    const el = highlightId ? highlightedRef.current : null;
    try {
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else readerTop.current?.scrollTo({ top: 0 });
    } catch {
      /* old browsers */
    }
  }, [isOpen, tab, highlightId, readerDocId, readerChapter]);

  const openDoc = (docId: string, chapterNumber = 1, verseId: string | null = null) => {
    setReaderDocId(docId);
    setReaderChapter(chapterNumber);
    setActiveSection(chapterNumber);
    setHighlightId(verseId);
    setTab('reader');
  };

  const copyPassage = (v: DocVerse) => {
    const quote = `"${v.text}"\n— Amaya Project Library [${v.reference}: ${v.docTitle}]`;
    try {
      void navigator.clipboard?.writeText(quote).catch(() => {});
    } catch {
      /* clipboard unavailable (insecure context) — the UI still confirms */
    }
    setCopiedId(v.id);
    setTimeout(() => setCopiedId(null), 2000);
  };
  const shareWhatsApp = (v: DocVerse) => {
    const text = encodeURIComponent(`*Amaya by Vera Vita — ${v.docShortName}*\n\n${v.text}\n\n_Source: ${v.docTitle} (${v.reference})_`);
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  };

  const passageCount = lib.verses.length;

  if (!isOpen) return null;

  const navItem = (id: Tab, label: string, Icon: React.ComponentType<{ size?: number }>, count?: number) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={cx(
        'flex items-center gap-2.5 rounded-xl text-[13px] font-semibold transition whitespace-nowrap',
        'px-3 py-2 md:w-full',
        tab === id || (id === 'documents' && tab === 'reader') ? 'bg-[#0B2A44] text-white shadow-xs' : 'text-[#3E5A70] hover:bg-white hover:text-[#0B2A44]',
      )}
    >
      <Icon size={16} />
      <span className="flex-1 text-left">{label}</span>
      {count !== undefined && <span className={cx('text-[10px] px-1.5 rounded-full', tab === id ? 'bg-white/20' : 'bg-[#E6EFF6] text-[#5E778C]')}>{count}</span>}
    </button>
  );

  const passageCard = ({ verse, highlightedText }: SearchMatch) => (
    <div key={verse.id} className="bg-white rounded-xl border border-[#D3E3F0] hover:border-[#0B6BB0]/60 p-4 transition">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#5E778C] mb-2">
        <span className="font-semibold text-[#0B2A44]">{verse.docShortName}</span>
        <span>›</span>
        <span className="truncate max-w-[16rem]">{verse.chapterTitle}</span>
        {verse.pageNumber && <span className="px-1.5 rounded bg-[#F2F7FB]">Page {verse.pageNumber}</span>}
        <span className="ml-auto font-mono text-[10px] text-[#7E93A6]">{verse.reference}</span>
      </div>
      <p className="text-sm text-[#0A1F33] leading-relaxed" dangerouslySetInnerHTML={{ __html: highlightedText }} />
      <div className="flex items-center gap-1.5 mt-3">
        <IconBtn title={copiedId === verse.id ? 'Copied' : 'Copy with source'} onClick={() => copyPassage(verse)}>
          {copiedId === verse.id ? <Check size={14} className="text-emerald-600" /> : <Copy size={14} />}
        </IconBtn>
        <IconBtn title="Send on WhatsApp" tone="green" onClick={() => shareWhatsApp(verse)}><Share2 size={14} /></IconBtn>
        <button
          type="button"
          onClick={() => openDoc(verse.docId, verse.chapterNumber, verse.id)}
          className="ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-[#0B6BB0] hover:bg-[#EEF6FC]"
        >
          Open in document <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );

  const documentCard = (doc: (typeof documents)[number]) => {
    const ext = extensionOf(doc.fileName, doc.downloadUrl);
    return (
      <div key={doc.id} className="bg-white rounded-xl border border-[#D3E3F0] hover:border-[#0B6BB0]/60 hover:shadow-xs transition p-4 flex gap-3">
        <div className="h-11 w-11 rounded-xl bg-[#F2F7FB] grid place-items-center shrink-0">
          <FileKindIcon name={doc.fileName || doc.downloadUrl} size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <h4 className="text-sm font-bold text-[#0B2A44] leading-snug flex-1 min-w-0">{doc.title}</h4>
            <CategoryPill category={doc.category} />
          </div>
          {doc.summary && <p className="text-xs text-[#5E778C] mt-1 line-clamp-2">{doc.summary}</p>}
          <div className="text-[11px] text-[#7E93A6] mt-1.5">{doc.chapters.length} {doc.chapters.length === 1 ? 'section' : 'sections'} · {doc.verses.length} passages{ext ? ` · ${ext}` : ''}</div>
          <div className="flex items-center gap-2 mt-2.5">
            <button type="button" onClick={() => openDoc(doc.id)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0B2A44] text-white hover:brightness-110">
              <BookOpen size={13} /> Read
            </button>
            {doc.downloadUrl && (
              <a href={doc.downloadUrl} download={downloadName(doc.fileName, doc.downloadUrl)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#D3E3F0] text-[#0B2A44] hover:bg-[#F2F7FB]">
                <Download size={13} /> Download{ext ? ` ${ext}` : ''}
              </a>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-[#0B2A44]/60 backdrop-blur-xs z-50 flex items-center justify-center p-0 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-[#F5F9FC] sm:rounded-2xl shadow-2xl border border-[#D3E3F0] max-w-6xl w-full h-full sm:h-[92vh] flex flex-col overflow-hidden">
        {/* header */}
        <div className="px-4 sm:px-5 py-3.5 bg-white border-b border-[#D3E3F0] flex items-center gap-3 shrink-0">
          <div className="p-2.5 rounded-xl bg-[#0B6BB0]/12 text-[#0B6BB0]"><Library size={22} /></div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base sm:text-lg font-bold text-[#0B2A44] leading-tight">Project Library</h2>
            <p className="text-[11px] sm:text-xs text-[#5E778C] truncate">
              {documents.length} documents · {passageCount} passages{lib.custom && lib.updatedAt ? ` · updated by ${lib.updatedBy || 'an admin'} on ${new Date(lib.updatedAt).toLocaleDateString()}` : ''}
            </p>
          </div>
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setShowUpload(true);
                setTab('documents');
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-[#0B6BB0] text-white hover:brightness-110 shadow-xs"
            >
              <Upload size={14} /> <span className="hidden sm:inline">Add files</span>
            </button>
          )}
          <button type="button" onClick={close} className="p-2 rounded-lg text-[#7E93A6] hover:text-[#0B2A44] hover:bg-[#F2F7FB]" aria-label="Close library">
            <X size={20} />
          </button>
        </div>

        <div className="flex-1 flex flex-col md:flex-row min-h-0">
          {/* menu: a side column on desktop, a row of tabs on phones */}
          <nav className="md:w-60 shrink-0 border-b md:border-b-0 md:border-r border-[#D3E3F0] bg-[#EEF4F9] p-2 md:p-3 flex md:flex-col gap-1 overflow-x-auto md:overflow-y-auto scrollbar-none">
            {navItem('search', 'Search', Search)}
            {navItem('documents', 'Documents', FileText, documents.length)}
            {navItem('facts', 'Quick facts', Building, facts.length)}
            {canEdit && navItem('edit', 'Edit library', Pencil)}
            <div className="hidden md:block pt-4 pb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[#7E93A6]">Read a document</div>
            <div className="hidden md:block space-y-0.5">
              {documents.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => openDoc(d.id)}
                  title={d.title}
                  className={cx('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition', tab === 'reader' && readerDoc?.id === d.id ? 'bg-white text-[#0B2A44] font-semibold shadow-2xs' : 'text-[#3E5A70] hover:bg-white/70')}
                >
                  <FileKindIcon name={d.fileName || d.downloadUrl} size={14} />
                  <span className="truncate">{d.shortName || d.title}</span>
                </button>
              ))}
            </div>
          </nav>

          {/* content */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            {tab === 'edit' && canEdit && <LibraryEditor onDirty={setEditing} />}

            {tab === 'search' && (
              <div className="flex-1 overflow-y-auto">
                <div className="sticky top-0 z-10 bg-[#F5F9FC]/95 backdrop-blur-xs border-b border-[#D3E3F0] p-3 sm:p-4 space-y-2.5">
                  <div className="relative">
                    <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#7E93A6]" />
                    <input
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      placeholder="Search any word or figure: MediCiti, 1,533 sq.ft, Vaastu, food package, RERA…"
                      className="w-full bg-white text-sm pl-10 pr-9 py-2.5 rounded-xl border border-[#B9CCDB] focus:outline-none focus:border-[#0B6BB0] focus:ring-1 focus:ring-[#0B6BB0] text-[#0B2A44] placeholder-[#7E93A6]"
                    />
                    {searchTerm && (
                      <button type="button" onClick={() => setSearchTerm('')} aria-label="Clear search" className="absolute right-3 top-1/2 -translate-y-1/2 text-[#7E93A6] hover:text-[#0B2A44]">
                        <X size={15} />
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={docFilter}
                      onChange={(e) => setDocFilter(e.target.value)}
                      className="text-xs px-2.5 py-1.5 rounded-lg border border-[#B9CCDB] bg-white text-[#0B2A44] focus:outline-none focus:border-[#0B6BB0] max-w-[14rem]"
                      aria-label="Search in"
                    >
                      <option value="all">All documents</option>
                      {documents.map((d) => <option key={d.id} value={d.id}>{d.shortName || d.title}</option>)}
                    </select>
                    <div className="flex rounded-lg border border-[#B9CCDB] bg-white p-0.5 text-[11px]">
                      {([['any', 'Any word'], ['all', 'All words'], ['phrase', 'Exact phrase']] as const).map(([m, label]) => (
                        <button key={m} type="button" onClick={() => setMatchMode(m)} className={cx('px-2.5 py-1 rounded-md font-medium transition', matchMode === m ? 'bg-[#0B2A44] text-white' : 'text-[#5E778C] hover:text-[#0B2A44]')}>
                          {label}
                        </button>
                      ))}
                    </div>
                    {q && <span className="text-[11px] text-[#5E778C] ml-auto">{matches.length} passages · {new Set(matches.map((m) => m.verse.docId)).size} documents</span>}
                  </div>
                </div>

                <div className="p-3 sm:p-5 space-y-5">
                  {!q && (
                    <>
                      <div>
                        <div className="text-[11px] font-semibold text-[#5E778C] mb-2 flex items-center gap-1.5"><Sparkles size={12} className="text-[#0B6BB0]" /> Popular searches</div>
                        <div className="flex flex-wrap gap-1.5">
                          {POPULAR.map((kw) => (
                            <button key={kw} type="button" onClick={() => setSearchTerm(kw)} className="px-2.5 py-1 rounded-full text-xs bg-white border border-[#D3E3F0] text-[#3E5A70] hover:border-[#0B6BB0] hover:text-[#0B2A44]">
                              {kw}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] font-semibold text-[#5E778C] mb-2">Documents</div>
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{documents.map(documentCard)}</div>
                      </div>
                    </>
                  )}

                  {q && matches.length > 0 && <div className="space-y-2.5">{matches.map(passageCard)}</div>}

                  {q && matchingFacts.length > 0 && (
                    <div>
                      <div className="text-[11px] font-semibold text-[#5E778C] mb-2">From quick facts</div>
                      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                        {matchingFacts.map((s, i) => (
                          <div key={i} className="bg-white rounded-xl border border-[#D3E3F0] p-3.5">
                            <div className="flex items-center gap-2 text-xs font-bold text-[#0B2A44] mb-1.5"><s.Icon size={14} className="text-[#0B6BB0]" /> {s.category}</div>
                            <ul className="space-y-1">
                              {s.items.map((item, j) => (
                                <li key={j} className="text-xs text-[#0F2233] leading-relaxed flex gap-2"><span className="text-[#0B6BB0]">•</span><span dangerouslySetInnerHTML={{ __html: highlightText(item, q) }} /></li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {q && !matches.length && !matchingFacts.length && (
                    <div className="bg-white rounded-xl border border-[#D3E3F0] p-8 text-center space-y-2">
                      <Search size={28} className="mx-auto text-[#7E93A6]" />
                      <h4 className="text-sm font-bold text-[#0B2A44]">Nothing found for “{searchTerm}”</h4>
                      <p className="text-xs text-[#5E778C]">Try fewer or broader words, like “BHK”, “amenities” or “hospital”.</p>
                      {(matchMode !== 'any' || docFilter !== 'all') && (
                        <button type="button" onClick={() => { setMatchMode('any'); setDocFilter('all'); }} className="mt-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0B2A44] text-white">
                          Search all documents, any word
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'documents' && (
              <div className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-sm font-bold text-[#0B2A44]">Documents</h3>
                    <p className="text-xs text-[#5E778C]">Read online or download the original. {canEdit ? 'Add PDF, Word or Excel files and their text becomes searchable.' : ''}</p>
                  </div>
                  {canEdit && !showUpload && (
                    <button type="button" onClick={() => setShowUpload(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#0B6BB0] text-[#0B6BB0] hover:bg-[#EEF6FC]">
                      <Upload size={13} /> Add files
                    </button>
                  )}
                </div>
                {canEdit && showUpload && (
                  <LibraryUpload
                    disabled={editing ? 'Save or discard your changes in “Edit library” first.' : undefined}
                    onAdded={(id) => openDoc(id)}
                  />
                )}
                {documents.length ? (
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{documents.map(documentCard)}</div>
                ) : (
                  <div className="bg-white rounded-xl border border-[#D3E3F0] p-8 text-center text-sm text-[#5E778C]">No documents yet.</div>
                )}
              </div>
            )}

            {tab === 'reader' && (!readerDoc || !chapter) && (
              <div className="flex-1 grid place-items-center p-8 text-sm text-[#5E778C]">This document has no text yet.</div>
            )}
            {tab === 'reader' && readerDoc && chapter && (
              <div className="flex-1 flex flex-col lg:flex-row min-h-0">
                {/* sections of this document */}
                <div className="lg:w-64 shrink-0 border-b lg:border-b-0 lg:border-r border-[#D3E3F0] bg-white p-3 overflow-y-auto max-h-44 lg:max-h-none">
                  <button type="button" onClick={() => setTab('documents')} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#0B6BB0] hover:underline mb-2">
                    <ArrowLeft size={12} /> All documents
                  </button>
                  <div className="flex items-start gap-2 mb-2">
                    <FileKindIcon name={readerDoc.fileName || readerDoc.downloadUrl} size={18} className="mt-0.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-[#0B2A44] leading-snug">{readerDoc.title}</div>
                      <div className="mt-1"><CategoryPill category={readerDoc.category} /></div>
                    </div>
                  </div>
                  {readerDoc.downloadUrl && (
                    <a href={readerDoc.downloadUrl} download={downloadName(readerDoc.fileName, readerDoc.downloadUrl)} className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 mb-3 rounded-lg text-xs font-semibold border border-[#D3E3F0] text-[#0B2A44] hover:bg-[#F2F7FB]">
                      <Download size={13} /> Download {extensionOf(readerDoc.fileName, readerDoc.downloadUrl)}
                    </a>
                  )}
                  <div role="group" aria-label="How to show the document" className="flex rounded-lg border border-[#D3E3F0] bg-[#F7FAFD] p-0.5 mb-3 text-[11px] font-semibold">
                    {([['cards', 'Fact cards'], ['sections', 'Section by section']] as const).map(([m, label]) => (
                      <button key={m} type="button" onClick={() => chooseReadMode(m)} aria-pressed={readMode === m} className={cx('flex-1 px-2 py-1 rounded-md transition', readMode === m ? 'bg-white text-[#0B2A44] shadow-sm' : 'text-[#5E778C] hover:text-[#0B2A44]')}>{label}</button>
                    ))}
                  </div>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[#7E93A6] mb-1 px-1">{readMode === 'cards' ? 'Jump to' : 'Sections'}</div>
                  <div className="space-y-0.5">
                    {readerDoc.chapters.map((c) => (
                      <button
                        key={c.chapterNumber}
                        type="button"
                        onClick={() => goToSection(c.chapterNumber)}
                        className={cx('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition', (readMode === 'sections' ? chapter.chapterNumber : activeSection) === c.chapterNumber ? 'bg-[#0B2A44] text-white' : 'text-[#3E5A70] hover:bg-[#F2F7FB]')}
                      >
                        <span className={cx('w-5 text-right tabular-nums text-[10px]', (readMode === 'sections' ? chapter.chapterNumber : activeSection) === c.chapterNumber ? 'text-white/70' : 'text-[#7E93A6]')}>{c.chapterNumber}</span>
                        <span className="truncate flex-1">{c.title}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* fact cards: every section on one page, bullets, key numbers in bold */}
                {readMode === 'cards' && (
                  <div ref={readerTop} className="flex-1 overflow-y-auto bg-[#F7FAFD]">
                    <div className="px-3 sm:px-5 py-4 sm:py-5">
                      <div className="mb-4">
                        <h3 className="text-lg sm:text-xl font-bold text-[#0B2A44] leading-snug">{readerDoc.title}</h3>
                        {readerDoc.summary && <p className="text-xs text-[#5E778C] mt-1 max-w-3xl">{readerDoc.summary}</p>}
                      </div>
                      <div className="columns-1 xl:columns-2 gap-4">
                        {readerDoc.chapters.map((c) => (
                          <section key={c.chapterNumber} id={`libsec-${c.chapterNumber}`} className="break-inside-avoid mb-4 bg-white rounded-xl border border-[#D3E3F0] p-4 scroll-mt-3">
                            <div className="flex items-center gap-2 pb-2 mb-2 border-b border-[#EEF4F9]">
                              <span className="w-6 h-6 rounded-lg bg-[#0B6BB0]/10 text-[#0B6BB0] grid place-items-center text-[11px] font-bold tabular-nums">{c.chapterNumber}</span>
                              <h4 className="text-sm font-bold text-[#0B2A44] flex-1">{c.title}</h4>
                              <span className="text-[10px] text-[#7E93A6]">{c.verses.length}</span>
                            </div>
                            <ul className="space-y-0.5">
                              {c.verses.map((v) => {
                                const lit = highlightId === v.id;
                                const loc = LOCATION_LINE.exec(v.text);
                                return (
                                  <li key={v.id} id={v.id} ref={lit ? (highlightedRef as unknown as React.Ref<HTMLLIElement>) : undefined} className={cx('group flex gap-2 rounded-md px-1.5 py-1 -mx-1.5 text-[13px] leading-relaxed text-[#0F2233] transition', lit ? 'bg-[#EEF6FC] ring-2 ring-[#0B6BB0]/40' : 'hover:bg-[#F7FAFD]')}>
                                    {loc ? (
                                      <span className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-2">
                                        <b className="font-semibold text-[#0B2A44]">{loc[1]}</b>
                                        <span className="text-[11px] text-[#7E93A6]">{loc[2]}</span>
                                        <span className="ml-auto tabular-nums whitespace-nowrap text-[#0B2A44]"><b className="font-semibold">{loc[3]} km</b> <span className="text-[#5E778C]">· {loc[4]} min</span></span>
                                      </span>
                                    ) : (
                                      <>
                                        <span className="text-[#0B6BB0] select-none">•</span>
                                        <span className="flex-1 min-w-0">
                                          {q ? <span dangerouslySetInnerHTML={{ __html: highlightText(v.text, q) }} /> : emphasise(v.text)}
                                          {v.pageNumber && <span className="ml-1.5 text-[10px] text-[#9AB0C2] whitespace-nowrap">p. {v.pageNumber}</span>}
                                        </span>
                                      </>
                                    )}
                                    <span className="flex items-start gap-1 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition">
                                      <IconBtn title={copiedId === v.id ? 'Copied' : 'Copy with source'} onClick={() => copyPassage(v)}>
                                        {copiedId === v.id ? <Check size={12} className="text-emerald-600" /> : <Copy size={12} />}
                                      </IconBtn>
                                      <IconBtn title="Send on WhatsApp" tone="green" onClick={() => shareWhatsApp(v)}><Share2 size={12} /></IconBtn>
                                    </span>
                                  </li>
                                );
                              })}
                            </ul>
                          </section>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* the section's text */}
                {readMode === 'sections' && (
                <div ref={readerTop} className="flex-1 overflow-y-auto bg-white">
                  <div className="max-w-3xl mx-auto px-4 sm:px-8 py-5 sm:py-7">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#0B6BB0]">{readerDoc.shortName} · Section {chapter.chapterNumber} of {readerDoc.chapters.length}</div>
                    <h3 className="text-xl sm:text-2xl font-bold text-[#0B2A44] mt-1 mb-5">{chapter.title}</h3>
                    <div className="space-y-1">
                      {chapter.verses.map((v) => {
                        const lit = highlightId === v.id;
                        return (
                          <div
                            key={v.id}
                            id={v.id}
                            ref={lit ? highlightedRef : undefined}
                            className={cx('group relative flex gap-3 rounded-lg px-2 py-2 -mx-2 transition', lit ? 'bg-[#EEF6FC] ring-2 ring-[#0B6BB0]/40' : 'hover:bg-[#F7FAFD]')}
                          >
                            <span className="w-8 shrink-0 text-right text-[10px] font-mono text-[#9AB0C2] pt-1 tabular-nums">{v.chapterNumber}.{v.verseNumber}</span>
                            <p className="flex-1 text-[15px] text-[#0A1F33] leading-relaxed">
                              {q ? <span dangerouslySetInnerHTML={{ __html: highlightText(v.text, q) }} /> : v.text}
                              {v.pageNumber && <span className="ml-2 text-[10px] text-[#9AB0C2] whitespace-nowrap">p. {v.pageNumber}</span>}
                            </p>
                            <div className="flex items-start gap-1 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition">
                              <IconBtn title={copiedId === v.id ? 'Copied' : 'Copy with source'} onClick={() => copyPassage(v)}>
                                {copiedId === v.id ? <Check size={13} className="text-emerald-600" /> : <Copy size={13} />}
                              </IconBtn>
                              <IconBtn title="Send on WhatsApp" tone="green" onClick={() => shareWhatsApp(v)}><Share2 size={13} /></IconBtn>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center justify-between mt-8 pt-4 border-t border-[#E6EFF6]">
                      <button
                        type="button"
                        disabled={chapter.chapterNumber <= 1}
                        onClick={() => { setReaderChapter(chapter.chapterNumber - 1); setHighlightId(null); }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#D3E3F0] text-[#0B2A44] hover:bg-[#F2F7FB] disabled:opacity-40"
                      >
                        <ChevronLeft size={14} /> Previous
                      </button>
                      <button
                        type="button"
                        disabled={chapter.chapterNumber >= readerDoc.chapters.length}
                        onClick={() => { setReaderChapter(chapter.chapterNumber + 1); setHighlightId(null); }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0B2A44] text-white hover:brightness-110 disabled:opacity-40"
                      >
                        Next <ChevronRight size={14} />
                      </button>
                    </div>
                  </div>
                </div>
                )}
              </div>
            )}

            {tab === 'facts' && (
              <div className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-4">
                <div>
                  <h3 className="text-sm font-bold text-[#0B2A44]">Quick facts</h3>
                  <p className="text-xs text-[#5E778C]">The key numbers at a glance: unit sizes, prices, packages and amenities.</p>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  {facts.map((s, i) => (
                    <div key={i} className="bg-white rounded-xl border border-[#D3E3F0] p-4">
                      <div className="flex items-center gap-2 pb-2 mb-2 border-b border-[#EEF4F9]">
                        <div className="p-1.5 rounded-lg bg-[#0B6BB0]/10 text-[#0B6BB0]"><s.Icon size={15} /></div>
                        <h4 className="text-sm font-bold text-[#0B2A44] flex-1">{s.category}</h4>
                        {s.docRef && <span className="text-[10px] font-mono text-[#7E93A6]">{s.docRef}</span>}
                      </div>
                      <ul className="space-y-1.5">
                        {s.items.map((item, j) => (
                          <li key={j} className="text-xs text-[#0F2233] leading-relaxed flex gap-2"><span className="text-[#0B6BB0]">•</span><span>{item}</span></li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* footer */}
        <div className="px-4 py-2 bg-white border-t border-[#D3E3F0] hidden sm:flex items-center gap-2 text-[11px] text-[#5E778C] shrink-0">
          <span className="font-semibold text-[#0B2A44]">Amaya by Vera Vita Living</span>
          <span>·</span>
          <span>TG RERA: P02200011109</span>
          <span>·</span>
          <span>Munirabad, Medchal, Hyderabad</span>
        </div>
      </div>
    </div>
  );
};
