import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  Search,
  BookOpen,
  MapPin,
  Building,
  ShieldCheck,
  DollarSign,
  HeartHandshake,
  Sparkles,
  Copy,
  Check,
  Share2,
  FileText,
  ArrowRight,
  Download,
  BookMarked,
  Eye,
} from 'lucide-react';
import {
  PROJECT_DOCUMENTS,
  DocVerse,
  searchProjectConcordance,
  SearchMatch,
  highlightTerms,
} from '../documents/projectDocuments';

interface LibraryModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialQuery?: string;
}

/** Escaped HTML of `text` with `q` (user input) highlighted — see highlightTerms. */
const highlightText = (text: string, q: string): string => highlightTerms(text, q ? [q] : []);

/** ".md" — the extension of the file a download link actually serves. */
function downloadExtension(url: string): string {
  const m = String(url || '').match(/\.([A-Za-z0-9]+)(?:[?#].*)?$/);
  return m ? `.${m[1].toLowerCase()}` : '';
}

/** Last path segment of the download URL, used as the suggested file name. */
function downloadFileName(url: string): string {
  const clean = String(url || '').split(/[?#]/)[0];
  const seg = clean.split('/').filter(Boolean).pop() || '';
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

export const LibraryModal: React.FC<LibraryModalProps> = ({
  isOpen,
  onClose,
  initialQuery = '',
}) => {
  const [searchTerm, setSearchTerm] = useState(initialQuery);
  const [activeTab, setActiveTab] = useState<'search' | 'reader' | 'quickSpecs' | 'repository'>('search');
  const [selectedDocFilter, setSelectedDocFilter] = useState<string>('all');
  const [matchMode, setMatchMode] = useState<'any' | 'phrase' | 'all'>('any');

  // Reader state
  const [readerDocId, setReaderDocId] = useState<string>('brochure');
  const [readerChapterNum, setReaderChapterNum] = useState<number>(1);
  const [highlightVerseId, setHighlightVerseId] = useState<string | null>(null);
  const highlightedVerseRef = useRef<HTMLDivElement | null>(null);

  // Copy feedback
  const [copiedVerseId, setCopiedVerseId] = useState<string | null>(null);

  // Re-sync the search box whenever the modal is (re)opened or the caller changes the query.
  useEffect(() => {
    if (!isOpen) return;
    setSearchTerm(initialQuery);
    if (initialQuery.trim()) setActiveTab('search');
  }, [isOpen, initialQuery]);

  // Escape closes the modal, like every other modal in the app.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // "Read in context": once the reader tab has rendered, bring the highlighted verse into view.
  useEffect(() => {
    if (!isOpen || activeTab !== 'reader' || !highlightVerseId) return;
    const el = highlightedVerseRef.current;
    if (!el) return;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch {
      el.scrollIntoView();
    }
  }, [isOpen, activeTab, highlightVerseId, readerDocId, readerChapterNum]);

  // Original Quick Reference Sections
  const quickSections = useMemo(
    () => [
      {
        category: 'Project Overview',
        icon: Building,
        docRef: 'Brochure 1:1',
        items: [
          'Amaya by Vera Vita - Senior Living Luxury Community',
          'Location: Munirabad Village, Medchal, Hyderabad',
          'Total Land: 13 acres (Phase 1: 3 acres development)',
          'Total Residences: 256 units across 3 residential towers (A, B, C)',
          'Tower Height: G + 12 floors with dedicated senior mobility lifts',
          'Club Amaya: 35,000+ sq. ft. private resident clubhouse',
          'RERA Registration No: TG RERA P02200011109',
          '100% Vaastu Compliant, zero-threshold anti-skid flooring throughout',
        ],
      },
      {
        category: 'Unit Types & Sizes',
        icon: ShieldCheck,
        docRef: 'Floor Plans 1:1',
        items: [
          '1 BHK-A: 691.90 sq.ft carpet | 953.21 sq.ft total built-up (Towers B & C)',
          '1 BHK-B: 737.27 sq.ft carpet | 1,015.72 sq.ft total built-up (Towers A, B, C)',
          '2 BHK-A: 1,112.94 sq.ft carpet | 1,533.28 sq.ft total built-up (Towers A, B, C)',
          '2 BHK-B: 1,107.21 sq.ft carpet | 1,525.38 sq.ft total built-up (Towers A, B, C)',
          '2.5 BHK-A: 1,231.08 sq.ft carpet | 1,696.03 sq.ft total built-up (Towers A, B, C)',
          '2.5 BHK-B: 1,256.48 sq.ft carpet | 1,731.03 sq.ft total built-up (Towers A, B, C)',
          '3 BHK: 1,548.72 sq.ft carpet | 2,133.65 sq.ft total built-up (Towers A, B, C)',
          '3.5 BHK: 1,782.63 sq.ft carpet | 2,455.89 sq.ft total built-up (Tower A only)',
        ],
      },
      {
        category: 'Pricing & Investment',
        icon: DollarSign,
        docRef: 'Payment Schedule 1:1',
        items: [
          'Basic Sale Price (BSP): ₹8,999 per sq.ft',
          'Car Parking: ₹2,50,000 (covered podium/basement slot)',
          'Corpus Fund: ₹200 / sq.ft for long-term reserve maintenance',
          'GST: 5% as per government senior housing guidelines',
          'Registration & Stamp Duty: 7.5% at deed execution',
          '1 BHK-A All-inclusive: Approx ₹1,00,90,821',
          '2 BHK-A All-inclusive: Approx ₹1,60,79,391',
          '3 BHK All-inclusive: Approx ₹2,22,77,536',
          '3.5 BHK All-inclusive: Approx ₹2,56,04,301',
        ],
      },
      {
        category: 'Monthly Assisted Living & Food Packages',
        icon: HeartHandshake,
        docRef: 'Packages 4:1',
        items: [
          'Food Package (Vegetarian): ₹12,500 per resident / month (4 nutrition-curated meals/day)',
          'Food Package (Non-Vegetarian): ₹15,000 per resident / month',
          '1 BHK-A Combined Living Package: ₹23,131 (Single) | ₹32,538 (Couple)',
          '2 BHK-A Combined Living Package: ₹31,482 (Single) | ₹40,889 (Couple)',
          '3 BHK Combined Living Package: ₹40,126 (Single) | ₹49,533 (Couple)',
          'Includes: Daily housekeeping, deep sanitization, laundry concierge, 24/7 security & on-campus paramedic support',
        ],
      },
      {
        category: 'Club Amaya & Lifestyle Amenities',
        icon: Sparkles,
        docRef: 'Brochure 3:1',
        items: [
          '35,000 sq.ft Club Amaya lifestyle & wellness center',
          'Heated indoor swimming pool with gentle hydrotherapy jets',
          'Senior-equipped fitness gym & dedicated yoga / meditation pavillion',
          'Acoustically treated movie screening theater with recliner seating',
          'Library, business center & co-working lounge for active seniors',
          'Indoor games arcade: billiards, chess, carrom, golf simulator',
          'Wellness spa, steam & salon for personal grooming',
          'Physiotherapy rehabilitation room with licensed practitioners',
          'Doctor’s consultation chamber & 24/7 standby emergency ambulance',
          '47,000 sq.ft of landscaped walking reflexology gardens & organic herb nursery',
        ],
      },
      {
        category: 'Key Distances & Connectivity',
        icon: MapPin,
        docRef: 'Brochure 2:4',
        items: [
          'Munirabad Town: 5 mins drive',
          'MediCiti Multi-speciality Hospital & Medical College: 12 mins',
          'Outer Ring Road (ORR Exit 6): 10 mins',
          'Kompally commercial high street: 20 mins',
          'Secunderabad Railway Station: 50 mins',
          'Gachibowli Financial District (via ORR): 60 mins',
          'Rajiv Gandhi International Airport (Shamshabad): 70 mins direct expressway',
          '700-acre Kandlakoya Reserve Forest: Directly adjacent & view facing',
        ],
      },
    ],
    []
  );

  const q = searchTerm.trim().toLowerCase();

  // Search concordance matches across full documents
  const concordanceMatches: SearchMatch[] = useMemo(() => {
    if (!q) return [];
    return searchProjectConcordance(q, selectedDocFilter, matchMode);
  }, [q, selectedDocFilter, matchMode]);

  // Matching quick sections
  const matchingQuickSections = useMemo(() => {
    if (!q) return quickSections;
    return quickSections
      .map((s) => ({
        ...s,
        items: s.items.filter(
          (item) => item.toLowerCase().includes(q) || s.category.toLowerCase().includes(q)
        ),
      }))
      .filter((s) => s.items.length > 0);
  }, [q, quickSections]);

  // Current reader document and chapter
  const currentReaderDoc = useMemo(() => {
    return PROJECT_DOCUMENTS.find((d) => d.id === readerDocId) || PROJECT_DOCUMENTS[0];
  }, [readerDocId]);

  const currentReaderChapter = useMemo(() => {
    return (
      currentReaderDoc.chapters.find((c) => c.chapterNumber === readerChapterNum) ||
      currentReaderDoc.chapters[0]
    );
  }, [currentReaderDoc, readerChapterNum]);

  // Popular search suggestions
  const popularKeywords = [
    'MediCiti',
    '1,533',
    '2.5 BHK',
    'Vaastu',
    'Vegetarian',
    'TG RERA',
    'Ambulance',
    'Milestones',
    'BSP ₹8,999',
    'Kandlakoya',
    'Escrow',
    'Grab rails',
    'Single',
    'Buggy',
  ];

  const handleCopyPassage = (verse: DocVerse) => {
    const quote = `"${verse.text}"\n— Amaya Knowledge Base [${verse.reference}: ${verse.docTitle}]`;
    try {
      void navigator.clipboard?.writeText(quote).catch(() => {});
    } catch {
      /* clipboard unavailable (insecure context) — the UI still confirms the selection */
    }
    setCopiedVerseId(verse.id);
    setTimeout(() => setCopiedVerseId(null), 2000);
  };

  const handleShareWhatsApp = (verse: DocVerse) => {
    const text = encodeURIComponent(
      `*Amaya by Vera Vita — Project Reference [${verse.reference}]*\n\n"${verse.text}"\n\n_Source: ${verse.docTitle}_`
    );
    window.open(`https://api.whatsapp.com/send?text=${text}`, '_blank');
  };

  const handleJumpToReader = (verse: DocVerse) => {
    setReaderDocId(verse.docId);
    setReaderChapterNum(verse.chapterNumber);
    setHighlightVerseId(verse.id);
    setActiveTab('reader');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-[#0B2A44]/60 backdrop-blur-xs z-50 flex items-center justify-center p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-[#FFFFFF] rounded-2xl shadow-2xl border border-[#D3E3F0] max-w-5xl w-full max-h-[92vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-[#D3E3F0] flex items-center justify-between bg-white shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-[#0B6BB0]/15 text-[#0B6BB0] shadow-xs">
              <BookOpen size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-serif text-lg sm:text-xl font-bold text-[#0B2A44]">
                  Amaya Project Library & Document Concordance
                </h2>
                <span className="hidden sm:inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold bg-[#0B6BB0]/15 text-[#0B5E9C] border border-[#0B6BB0]/30">
                  Bible-Style Search
                </span>
              </div>
              <p className="text-xs text-[#5E778C] line-clamp-1">
                Verse-by-verse indexing across Brochure, Floor Plans, Packages, Payment Milestones & Legal Documents
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-[#7E93A6] hover:text-[#0B2A44] hover:bg-[#F2F7FB] transition"
            aria-label="Close modal"
          >
            <X size={20} />
          </button>
        </div>

        {/* Tab switcher */}
        <div className="bg-[#F2F7FB] px-4 pt-2.5 border-b border-[#D3E3F0] flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center space-x-1 sm:space-x-2 overflow-x-auto pb-2 scrollbar-none">
            <button
              onClick={() => setActiveTab('search')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                activeTab === 'search'
                  ? 'bg-white text-[#0B2A44] shadow-xs border border-[#D3E3F0]'
                  : 'text-[#5E778C] hover:text-[#0B2A44] hover:bg-white/60'
              }`}
            >
              <Search size={14} />
              <span>Concordance Search</span>
              {q && concordanceMatches.length > 0 && (
                <span className="px-1.5 py-0.2 rounded-full text-[10px] bg-[#0B6BB0] text-white">
                  {concordanceMatches.length}
                </span>
              )}
            </button>

            <button
              onClick={() => setActiveTab('reader')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                activeTab === 'reader'
                  ? 'bg-white text-[#0B2A44] shadow-xs border border-[#D3E3F0]'
                  : 'text-[#5E778C] hover:text-[#0B2A44] hover:bg-white/60'
              }`}
            >
              <BookMarked size={14} />
              <span>Document Reader</span>
            </button>

            <button
              onClick={() => setActiveTab('quickSpecs')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                activeTab === 'quickSpecs'
                  ? 'bg-white text-[#0B2A44] shadow-xs border border-[#D3E3F0]'
                  : 'text-[#5E778C] hover:text-[#0B2A44] hover:bg-white/60'
              }`}
            >
              <Building size={14} />
              <span>Quick Reference Specs</span>
            </button>

            <button
              onClick={() => setActiveTab('repository')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition ${
                activeTab === 'repository'
                  ? 'bg-white text-[#0B2A44] shadow-xs border border-[#D3E3F0]'
                  : 'text-[#5E778C] hover:text-[#0B2A44] hover:bg-white/60'
              }`}
            >
              <FileText size={14} />
              <span>Documents Folder ({PROJECT_DOCUMENTS.length})</span>
            </button>
          </div>

          <span className="text-[11px] text-[#6F8698] hidden md:inline-block pb-2">
            Storage: <code className="bg-white/80 px-1.5 py-0.5 rounded border border-[#D3E3F0]">/documents</code>
          </span>
        </div>

        {/* Global Search Toolbar (available in all tabs) */}
        <div className="p-3.5 sm:p-4 bg-[#E6EFF6] border-b border-[#D3E3F0] space-y-2.5 shrink-0">
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <div className="relative flex-1">
              <Search size={16} className="absolute left-3.5 top-3 text-[#7E93A6]" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  if (activeTab !== 'search' && activeTab !== 'reader') {
                    setActiveTab('search');
                  }
                }}
                placeholder="Search any word or phrase: MediCiti, 1,533 sq.ft, Vaastu, 2.5 BHK, food package, RERA, 8,999..."
                className="w-full bg-white text-xs sm:text-sm pl-10 pr-9 py-2.5 rounded-xl border border-[#B9CCDB] focus:outline-none focus:border-[#0B6BB0] focus:ring-1 focus:ring-[#0B6BB0] text-[#0B2A44] placeholder-[#7E93A6] shadow-2xs"
              />
              {searchTerm && (
                <button
                  onClick={() => setSearchTerm('')}
                  className="absolute right-3 top-3 text-[#7E93A6] hover:text-[#0B2A44]"
                >
                  <X size={15} />
                </button>
              )}
            </div>

            {/* Document Filter Dropdown */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <select
                  value={selectedDocFilter}
                  onChange={(e) => setSelectedDocFilter(e.target.value)}
                  className="text-xs px-3 py-2.5 rounded-xl border border-[#B9CCDB] bg-white text-[#0B2A44] focus:outline-none focus:border-[#0B6BB0] shadow-2xs"
                >
                  <option value="all">All Documents (Full Canon)</option>
                  <option value="brochure">📖 Master Brochure</option>
                  <option value="floor-plans">📐 Floor Plans & Layouts</option>
                  <option value="monthly-packages">🥗 Monthly Care Packages</option>
                  <option value="payment-schedule">💳 Payment Milestones</option>
                  <option value="legal-rera">⚖️ Legal & RERA Sanctions</option>
                </select>
              </div>

              {/* Match Mode */}
              <div className="flex rounded-xl border border-[#B9CCDB] bg-white p-0.5 shadow-2xs text-[11px]">
                <button
                  type="button"
                  onClick={() => setMatchMode('any')}
                  className={`px-2.5 py-1.5 rounded-lg font-medium transition ${
                    matchMode === 'any' ? 'bg-[#0B2A44] text-white shadow-2xs' : 'text-[#5E778C] hover:text-[#0B2A44]'
                  }`}
                  title="Matches any of the search words"
                >
                  Any Word
                </button>
                <button
                  type="button"
                  onClick={() => setMatchMode('phrase')}
                  className={`px-2.5 py-1.5 rounded-lg font-medium transition ${
                    matchMode === 'phrase' ? 'bg-[#0B2A44] text-white shadow-2xs' : 'text-[#5E778C] hover:text-[#0B2A44]'
                  }`}
                  title="Matches exact consecutive phrase"
                >
                  Exact Phrase
                </button>
                <button
                  type="button"
                  onClick={() => setMatchMode('all')}
                  className={`px-2.5 py-1.5 rounded-lg font-medium transition ${
                    matchMode === 'all' ? 'bg-[#0B2A44] text-white shadow-2xs' : 'text-[#5E778C] hover:text-[#0B2A44]'
                  }`}
                  title="Matches all words anywhere in the passage"
                >
                  All Words
                </button>
              </div>
            </div>
          </div>

          {/* Quick search chips */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 scrollbar-none text-[11px]">
            <span className="text-[#6F8698] font-medium shrink-0 flex items-center gap-1">
              <Sparkles size={11} className="text-[#0B6BB0]" />
              Quick lookup:
            </span>
            {popularKeywords.map((kw) => (
              <button
                key={kw}
                onClick={() => {
                  setSearchTerm(kw);
                  setActiveTab('search');
                }}
                className={`px-2 py-0.5 rounded-full border transition shrink-0 ${
                  searchTerm.toLowerCase() === kw.toLowerCase()
                    ? 'bg-[#0B6BB0] text-white border-[#0B6BB0]'
                    : 'bg-white text-[#5E778C] border-[#D3E3F0] hover:border-[#0B6BB0] hover:text-[#0B2A44]'
                }`}
              >
                {kw}
              </button>
            ))}
          </div>
        </div>

        {/* Tab 1: Concordance Search View (Bible-style search) */}
        {activeTab === 'search' && (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
            {/* Search Summary Header */}
            {q ? (
              <div className="bg-[#F7FAFD] p-4 rounded-xl border border-[#D3E3F0] flex flex-wrap items-center justify-between gap-3 shadow-xs">
                <div>
                  <h3 className="font-serif text-sm sm:text-base font-bold text-[#0B2A44] flex items-center gap-2">
                    <span>Search Results for:</span>
                    <span className="text-[#0B6BB0] font-sans font-semibold bg-white px-2.5 py-0.5 rounded-lg border border-[#D3E3F0]">
                      "{searchTerm}"
                    </span>
                  </h3>
                  <p className="text-xs text-[#5E778C] mt-0.5">
                    Found{' '}
                    <strong className="text-[#0B2A44]">{concordanceMatches.length}</strong> matching passages across{' '}
                    <strong className="text-[#0B2A44]">
                      {new Set(concordanceMatches.map((m) => m.verse.docId)).size}
                    </strong>{' '}
                    project documents &{' '}
                    <strong className="text-[#0B2A44]">{matchingQuickSections.length}</strong> quick spec categories.
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (concordanceMatches.length > 0) {
                        handleJumpToReader(concordanceMatches[0].verse);
                      }
                    }}
                    disabled={concordanceMatches.length === 0}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0B2A44] text-white hover:brightness-110 disabled:opacity-40 transition"
                  >
                    <BookMarked size={13} />
                    <span>Read in Book Mode</span>
                  </button>
                </div>
              </div>
            ) : (
              <div className="bg-[#F7FAFD] p-4 rounded-xl border border-[#D3E3F0] text-center space-y-2">
                <BookOpen size={28} className="mx-auto text-[#0B6BB0]/60" />
                <h3 className="font-serif text-base font-bold text-[#0B2A44]">
                  Search Full Project Documentation Like a Bible Concordance
                </h3>
                <p className="text-xs text-[#5E778C] max-w-xl mx-auto leading-relaxed">
                  Enter any word, unit size, amenity, distance, clause, or financial term to instantly discover every cited verse across the Brochure, Floor Plans, Monthly Care Packages, Payment Schedule, and Legal Sanctions.
                </p>
              </div>
            )}

            {/* Document Verses Section (Concordance Results) */}
            {concordanceMatches.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between pb-1 border-b border-[#D3E3F0]">
                  <h4 className="font-serif text-sm font-bold text-[#0B2A44] flex items-center gap-2">
                    <FileText size={16} className="text-[#0B6BB0]" />
                    <span>Project Document Passages ({concordanceMatches.length})</span>
                  </h4>
                  <span className="text-[11px] text-[#6F8698]">
                    Click "Read in Context" to open full chapter
                  </span>
                </div>

                <div className="grid grid-cols-1 gap-3">
                  {concordanceMatches.map(({ verse, highlightedText }) => {
                    const isCopied = copiedVerseId === verse.id;

                    return (
                      <div
                        key={verse.id}
                        className="bg-white rounded-xl p-4 sm:p-5 border border-[#D3E3F0] hover:border-[#0B6BB0] shadow-xs transition group flex flex-col justify-between"
                      >
                        {/* Reference citation header */}
                        <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 mb-2.5 border-b border-[#F2F7FB]">
                          <div className="flex items-center gap-2">
                            <span className="px-2.5 py-0.5 rounded-md text-xs font-bold font-mono bg-[#0B2A44] text-white tracking-wide">
                              [{verse.reference}]
                            </span>
                            <span className="text-xs font-semibold text-[#0B2A44]">
                              {verse.docShortName} — Chapter {verse.chapterNumber}: {verse.chapterTitle}
                            </span>
                          </div>

                          <div className="flex items-center gap-1.5">
                            {verse.pageNumber && (
                              <span className="text-[10px] text-[#7E93A6] px-2 py-0.5 rounded bg-[#F2F7FB] font-medium">
                                Page {verse.pageNumber}
                              </span>
                            )}
                            <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded bg-[#0B6BB0]/10 text-[#0B5E9C]">
                              {verse.category}
                            </span>
                          </div>
                        </div>

                        {/* Verse Text with Bible-style typography */}
                        <div className="text-sm font-serif text-[#0A1F33] leading-relaxed mb-4 pl-3 border-l-2 border-[#0B6BB0]/40">
                          <span className="font-sans font-bold text-xs text-[#0B6BB0] mr-2">
                            § {verse.chapterNumber}.{verse.verseNumber}
                          </span>
                          <span
                            dangerouslySetInnerHTML={{
                              __html: highlightedText,
                            }}
                          />
                        </div>

                        {/* Tags & Action Buttons */}
                        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#F2F7FB]">
                          <div className="flex flex-wrap gap-1">
                            {verse.tags.slice(0, 4).map((tag, tIdx) => (
                              <span
                                key={tIdx}
                                className="text-[10px] bg-[#F2F7FB] text-[#5E778C] px-2 py-0.5 rounded-full"
                              >
                                #{tag}
                              </span>
                            ))}
                          </div>

                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => handleCopyPassage(verse)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium text-[#5E778C] hover:text-[#0B2A44] hover:bg-[#F2F7FB] transition border border-[#D3E3F0]/80"
                              title="Copy verse text with citation"
                            >
                              {isCopied ? (
                                <>
                                  <Check size={12} className="text-emerald-600" />
                                  <span className="text-emerald-700 font-semibold">Copied!</span>
                                </>
                              ) : (
                                <>
                                  <Copy size={12} />
                                  <span>Copy Verse</span>
                                </>
                              )}
                            </button>

                            <button
                              onClick={() => handleShareWhatsApp(verse)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium text-[#1E7E34] hover:bg-emerald-50 transition border border-emerald-200"
                              title="Share passage on WhatsApp"
                            >
                              <Share2 size={12} />
                              <span>WhatsApp</span>
                            </button>

                            <button
                              onClick={() => handleJumpToReader(verse)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold bg-[#0B2A44] text-white hover:brightness-110 transition shadow-2xs"
                            >
                              <span>Read in Context</span>
                              <ArrowRight size={12} />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Quick Reference Summary Cards (Always accessible) */}
            <div className="space-y-3 pt-2">
              <div className="flex items-center justify-between pb-1 border-b border-[#D3E3F0]">
                <h4 className="font-serif text-sm font-bold text-[#0B2A44] flex items-center gap-2">
                  <Building size={16} className="text-[#0B6BB0]" />
                  <span>
                    Quick Reference Summary Cards{' '}
                    {q && `(${matchingQuickSections.length} matching sections)`}
                  </span>
                </h4>
                <button
                  onClick={() => setActiveTab('quickSpecs')}
                  className="text-xs text-[#0B6BB0] hover:underline font-semibold"
                >
                  View All Specs →
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {matchingQuickSections.map((section, sIdx) => {
                  const SectionIcon = section.icon;

                  return (
                    <div
                      key={sIdx}
                      className="bg-white rounded-xl p-4 border border-[#D3E3F0] shadow-xs flex flex-col justify-between"
                    >
                      <div>
                        <div className="flex items-center justify-between pb-2 mb-2 border-b border-[#E6EFF6]">
                          <div className="flex items-center gap-2">
                            <SectionIcon size={16} className="text-[#0B6BB0]" />
                            <h5 className="font-serif text-sm font-bold text-[#0B2A44]">
                              {section.category}
                            </h5>
                          </div>
                          <span className="text-[10px] font-mono bg-[#F2F7FB] text-[#5E778C] px-2 py-0.5 rounded">
                            {section.docRef}
                          </span>
                        </div>

                        <div className="space-y-1.5">
                          {section.items.map((item, iIdx) => (
                            <div
                              key={iIdx}
                              className="text-xs text-[#0F2233] leading-relaxed flex items-start gap-2 py-0.5"
                            >
                              <span className="text-[#0B6BB0] font-bold mt-0.5">•</span>
                              <span className="flex-1">
                                {q ? (
                                  <span
                                    dangerouslySetInnerHTML={{
                                      __html: highlightText(item, q),
                                    }}
                                  />
                                ) : (
                                  item
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Zero results state */}
            {q && concordanceMatches.length === 0 && matchingQuickSections.length === 0 && (
              <div className="bg-white p-8 rounded-xl border border-[#D3E3F0] text-center space-y-3">
                <Search size={32} className="mx-auto text-[#7E93A6]" />
                <h4 className="font-serif text-base font-bold text-[#0B2A44]">
                  No direct verses found for "{searchTerm}"
                </h4>
                <p className="text-xs text-[#5E778C] max-w-md mx-auto">
                  Try switching the match mode to <strong>"Any Word"</strong> or search for broader keywords like <em>"BHK"</em>, <em>"Medchal"</em>, <em>"Amenities"</em>, <em>"RERA"</em>, or <em>"Hospital"</em>.
                </p>
                <div className="pt-2">
                  <button
                    onClick={() => {
                      setMatchMode('any');
                      setSelectedDocFilter('all');
                    }}
                    className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#0B2A44] text-white hover:brightness-110"
                  >
                    Reset Filters & Try Again
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: Document Reader Mode (Bible-style chapter reader) */}
        {activeTab === 'reader' && (
          <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
            {/* Left Sidebar: Document / Chapter Index */}
            <div className="w-full md:w-72 bg-[#F5F9FC] border-b md:border-b-0 md:border-r border-[#D3E3F0] p-3 sm:p-4 overflow-y-auto shrink-0 space-y-3">
              <div>
                <label className="text-[11px] font-bold text-[#5E778C] uppercase tracking-wider block mb-1.5">
                  Select Book / Document
                </label>
                <select
                  value={readerDocId}
                  onChange={(e) => {
                    setReaderDocId(e.target.value);
                    setReaderChapterNum(1);
                    setHighlightVerseId(null);
                  }}
                  className="w-full text-xs font-semibold p-2.5 rounded-xl border border-[#B9CCDB] bg-white text-[#0B2A44] focus:outline-none focus:border-[#0B6BB0]"
                >
                  {PROJECT_DOCUMENTS.map((doc) => (
                    <option key={doc.id} value={doc.id}>
                      {doc.shortName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[11px] font-bold text-[#5E778C] uppercase tracking-wider block mb-1.5">
                  Chapters in this Document
                </label>
                <div className="space-y-1">
                  {currentReaderDoc.chapters.map((ch) => (
                    <button
                      key={ch.chapterNumber}
                      onClick={() => {
                        setReaderChapterNum(ch.chapterNumber);
                        setHighlightVerseId(null);
                      }}
                      className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition flex items-center justify-between ${
                        readerChapterNum === ch.chapterNumber
                          ? 'bg-[#0B2A44] text-white shadow-2xs'
                          : 'bg-white/70 hover:bg-white text-[#0F2233] border border-transparent hover:border-[#D3E3F0]'
                      }`}
                    >
                      <span className="truncate">
                        Chapter {ch.chapterNumber}: {ch.title}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                          readerChapterNum === ch.chapterNumber
                            ? 'bg-white/20 text-white'
                            : 'bg-[#E6EFF6] text-[#5E778C]'
                        }`}
                      >
                        {ch.verses.length}v
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Document Metadata card */}
              <div className="p-3 bg-white rounded-xl border border-[#D3E3F0] text-xs space-y-2">
                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold border ${currentReaderDoc.badgeColor}`}>
                  {currentReaderDoc.category}
                </span>
                <p className="text-[11px] text-[#5E778C] leading-relaxed">
                  {currentReaderDoc.summary}
                </p>
                <div className="pt-1 flex items-center justify-between gap-2 border-t border-[#F2F7FB]">
                  <span className="text-[10px] text-[#7E93A6] truncate" title={currentReaderDoc.fileName}>{currentReaderDoc.fileName}</span>
                  <a
                    href={currentReaderDoc.downloadUrl}
                    download={downloadFileName(currentReaderDoc.downloadUrl)}
                    className="text-[10px] font-semibold text-[#0B6BB0] hover:underline inline-flex items-center gap-1 shrink-0"
                  >
                    <Download size={11} />
                    <span>Download {downloadExtension(currentReaderDoc.downloadUrl)}</span>
                  </a>
                </div>
              </div>
            </div>

            {/* Right: Chapter Content formatted like a Bible book */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-8 bg-[#FFFFFF] space-y-6">
              {/* Chapter Header */}
              <div className="pb-4 border-b border-[#D3E3F0] flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="text-xs font-semibold text-[#0B6BB0] uppercase tracking-wider">
                    {currentReaderDoc.shortName}
                  </span>
                  <h3 className="font-serif text-xl sm:text-2xl font-bold text-[#0B2A44] mt-0.5">
                    Chapter {currentReaderChapter.chapterNumber}: {currentReaderChapter.title}
                  </h3>
                </div>

                <div className="flex items-center gap-2">
                  <a
                    href={currentReaderDoc.downloadUrl}
                    download={downloadFileName(currentReaderDoc.downloadUrl)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#D3E3F0] bg-white text-[#0B2A44] hover:bg-[#F2F7FB] transition"
                  >
                    <Download size={13} />
                    <span>Download Markdown ({downloadExtension(currentReaderDoc.downloadUrl)})</span>
                  </a>
                </div>
              </div>

              {/* Verse-by-verse chapter reader */}
              <div className="space-y-4 max-w-3xl">
                {currentReaderChapter.verses.map((verse) => {
                  const isHighlighted = highlightVerseId === verse.id;
                  const isCopied = copiedVerseId === verse.id;

                  return (
                    <div
                      key={verse.id}
                      id={verse.id}
                      ref={isHighlighted ? highlightedVerseRef : undefined}
                      className={`p-4 rounded-xl transition border ${
                        isHighlighted
                          ? 'bg-[#EEF6FC] border-[#0B6BB0] shadow-md ring-2 ring-[#0B6BB0]/40'
                          : 'bg-white border-[#E6EFF6] hover:border-[#D3E3F0]'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="space-y-1 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-serif font-bold text-sm text-[#0B6BB0]">
                              § {verse.chapterNumber}.{verse.verseNumber}
                            </span>
                            <span className="text-[10px] font-mono text-[#7E93A6]">
                              [{verse.reference}]
                            </span>
                            {verse.pageNumber && (
                              <span className="text-[10px] text-[#7E93A6]">
                                (Page {verse.pageNumber})
                              </span>
                            )}
                          </div>
                          <p className="font-serif text-sm sm:text-base text-[#0A1F33] leading-relaxed">
                            {q ? (
                              <span
                                dangerouslySetInnerHTML={{
                                  __html: highlightText(verse.text, q),
                                }}
                              />
                            ) : (
                              verse.text
                            )}
                          </p>
                        </div>

                        <div className="flex items-center gap-1 shrink-0 pt-1">
                          <button
                            onClick={() => handleCopyPassage(verse)}
                            className="p-1.5 rounded-md text-[#7E93A6] hover:text-[#0B2A44] hover:bg-[#F2F7FB]"
                            title="Copy verse"
                          >
                            {isCopied ? (
                              <Check size={14} className="text-emerald-600" />
                            ) : (
                              <Copy size={14} />
                            )}
                          </button>
                          <button
                            onClick={() => handleShareWhatsApp(verse)}
                            className="p-1.5 rounded-md text-emerald-600 hover:bg-emerald-50"
                            title="Share on WhatsApp"
                          >
                            <Share2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Chapter Next / Previous controls */}
              <div className="flex items-center justify-between pt-6 border-t border-[#D3E3F0]">
                <button
                  onClick={() => {
                    if (readerChapterNum > 1) {
                      setReaderChapterNum(readerChapterNum - 1);
                      setHighlightVerseId(null);
                    }
                  }}
                  disabled={readerChapterNum <= 1}
                  className="px-3.5 py-2 rounded-lg text-xs font-semibold border border-[#D3E3F0] bg-white text-[#0B2A44] hover:bg-[#F2F7FB] disabled:opacity-40 transition"
                >
                  ← Previous Chapter
                </button>

                <span className="text-xs font-medium text-[#5E778C]">
                  Chapter {readerChapterNum} of {currentReaderDoc.chapters.length}
                </span>

                <button
                  onClick={() => {
                    if (readerChapterNum < currentReaderDoc.chapters.length) {
                      setReaderChapterNum(readerChapterNum + 1);
                      setHighlightVerseId(null);
                    }
                  }}
                  disabled={readerChapterNum >= currentReaderDoc.chapters.length}
                  className="px-3.5 py-2 rounded-lg text-xs font-semibold bg-[#0B2A44] text-white hover:brightness-110 disabled:opacity-40 transition"
                >
                  Next Chapter →
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Quick Reference Specs View (Original Library Content preserved) */}
        {activeTab === 'quickSpecs' && (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
            <div className="bg-[#F7FAFD] p-4 rounded-xl border border-[#D3E3F0] flex items-center justify-between gap-3">
              <div>
                <h3 className="font-serif text-base font-bold text-[#0B2A44]">
                  Quick Reference Project Specifications
                </h3>
                <p className="text-xs text-[#5E778C]">
                  Executive summaries of unit sizes, pricing slabs, food care packages & Clubhouse amenities
                </p>
              </div>
              <button
                onClick={() => setActiveTab('search')}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0B2A44] text-white hover:brightness-110 transition"
              >
                Switch to Bible Concordance Search
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {matchingQuickSections.map((section, sIdx) => {
                const SectionIcon = section.icon;

                return (
                  <div
                    key={sIdx}
                    className="bg-white rounded-xl p-5 border border-[#D3E3F0] shadow-xs flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center justify-between pb-2.5 mb-3 border-b border-[#E6EFF6]">
                        <div className="flex items-center gap-2">
                          <div className="p-1.5 rounded-lg bg-[#0B6BB0]/10 text-[#0B6BB0]">
                            <SectionIcon size={16} />
                          </div>
                          <h4 className="font-serif text-base font-bold text-[#0B2A44]">
                            {section.category}
                          </h4>
                        </div>
                        <span className="text-[11px] font-mono text-[#0B5E9C] bg-[#0B6BB0]/10 px-2 py-0.5 rounded">
                          {section.docRef}
                        </span>
                      </div>

                      <div className="space-y-2">
                        {section.items.map((item, iIdx) => (
                          <div
                            key={iIdx}
                            className="text-xs text-[#0F2233] leading-relaxed flex items-start gap-2 py-0.5"
                          >
                            <span className="text-[#0B6BB0] font-bold">•</span>
                            <span className="flex-1">
                              {q ? (
                                <span
                                  dangerouslySetInnerHTML={{
                                    __html: highlightText(item, q),
                                  }}
                                />
                              ) : (
                                item
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Tab 4: Documents Folder Repository */}
        {activeTab === 'repository' && (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
            <div className="bg-[#F7FAFD] p-4 rounded-xl border border-[#D3E3F0] flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-serif text-base font-bold text-[#0B2A44]">
                  Official Project Documents Folder Repository
                </h3>
                <p className="text-xs text-[#5E778C]">
                  All documents are permanently stored in the project's <code className="bg-white px-1.5 py-0.5 rounded border border-[#D3E3F0]">/documents</code> directory, accessible via search, direct read mode, or download.
                </p>
              </div>
              <span className="px-3 py-1 rounded-full text-xs font-semibold bg-[#0B2A44] text-white">
                {PROJECT_DOCUMENTS.length} Active Documents
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {PROJECT_DOCUMENTS.map((doc) => (
                <div
                  key={doc.id}
                  className="bg-white rounded-xl p-5 border border-[#D3E3F0] hover:border-[#0B6BB0] shadow-xs transition flex flex-col justify-between"
                >
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-semibold border ${doc.badgeColor}`}>
                        {doc.category}
                      </span>
                      <span className="text-[10px] font-mono text-[#7E93A6]">
                        {doc.chapters.length} Chapters • {doc.verses.length} Indexed Verses
                      </span>
                    </div>

                    <div>
                      <h4 className="font-serif text-base font-bold text-[#0B2A44] leading-snug">
                        {doc.title}
                      </h4>
                      <p className="text-xs text-[#5E778C] mt-1.5 leading-relaxed">
                        {doc.summary}
                      </p>
                    </div>

                    <div className="p-2.5 rounded-lg bg-[#F2F7FB] text-[11px] text-[#0F2233] font-mono space-y-1">
                      <div className="break-all">Source: {doc.fileName}</div>
                      <div className="text-[10px] text-[#7E93A6] break-all">Download: {doc.downloadUrl}</div>
                    </div>
                  </div>

                  <div className="pt-4 mt-3 border-t border-[#E6EFF6] flex items-center justify-between gap-2">
                    <button
                      onClick={() => {
                        setReaderDocId(doc.id);
                        setReaderChapterNum(1);
                        setHighlightVerseId(null);
                        setActiveTab('reader');
                      }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#0B2A44] text-white hover:brightness-110 transition shadow-2xs"
                    >
                      <Eye size={13} />
                      <span>Read in Library</span>
                    </button>

                    <a
                      href={doc.downloadUrl}
                      download={downloadFileName(doc.downloadUrl)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-[#D3E3F0] text-[#0B2A44] hover:bg-[#F2F7FB] transition"
                    >
                      <Download size={13} />
                      <span>Download {downloadExtension(doc.downloadUrl)}</span>
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="p-3 sm:p-4 bg-white border-t border-[#D3E3F0] flex flex-wrap items-center justify-between gap-2 text-xs text-[#5E778C] shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[#0B2A44]">Amaya by Vera Vita Living</span>
            <span>•</span>
            <span>TG RERA: P02200011109</span>
            <span>•</span>
            <span>Munirabad, Medchal, Hyderabad</span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#E6EFF6] hover:bg-[#D3E3F0] text-[#0B2A44] transition"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
