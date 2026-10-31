/**
 * The Project Library's content shape (documents → chapters → passages, plus the Quick Specs sections), the library
 * built into the app, and turning content into searchable passages. No React here: the server uses it too
 * (server/modules/library.ts); the browser store is in projectLibrary.ts.
 */
import { PROJECT_DOCUMENTS, type DocVerse, type ProjectDocument } from './projectDocuments';
import { locationsDoc } from './amayaLocations';

export type LibraryCategory = ProjectDocument['category'];
export const LIBRARY_CATEGORIES: LibraryCategory[] = ['Brochure', 'Floor Plans', 'Monthly Packages', 'Pricing & Payment', 'Legal & RERA', 'Locations'];
export const SECTION_ICONS = ['building', 'shield', 'money', 'heart', 'sparkles', 'map', 'book', 'file'] as const;
export type SectionIcon = (typeof SECTION_ICONS)[number];

export interface LibraryPassage { text: string; tags?: string[]; pageNumber?: number }
export interface LibraryChapter { title: string; passages: LibraryPassage[] }
export interface LibraryDoc {
  id: string;
  title: string;
  shortName: string;
  /** The name in references ("Brochure 2:4"). */
  refName: string;
  /** The document's name on search results. */
  refTitle: string;
  /** Passage ids ("BRO-2:4"). */
  idPrefix: string;
  category: LibraryCategory;
  badgeColor: string;
  summary: string;
  fileName: string;
  downloadUrl: string;
  chapters: LibraryChapter[];
}
export interface LibrarySection { category: string; docRef: string; icon: SectionIcon | string; items: string[] }
export interface LibraryContent { documents: LibraryDoc[]; sections: LibrarySection[] }
/** What the server answers: `editors` comes only to admins. */
export interface LibraryResponse { content: LibraryContent | null; updatedAt: string; updatedBy: string; canEdit?: boolean; editors?: string[] }

const DEFAULT_SECTIONS: LibrarySection[] = [
  {
    category: 'Project Overview',
    icon: 'building',
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
    icon: 'shield',
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
    icon: 'money',
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
    icon: 'heart',
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
    icon: 'sparkles',
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
    icon: 'map',
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
];

/** The built-in library in the editable shape. */
export function defaultLibrary(): LibraryContent {
  return {
    documents: PROJECT_DOCUMENTS.map((d): LibraryDoc => {
      const first = d.chapters[0]?.verses[0];
      return {
        id: d.id, title: d.title, shortName: d.shortName,
        refName: first?.docShortName || d.shortName, refTitle: first?.docTitle || d.title, idPrefix: first ? first.id.split('-')[0] : 'DOC',
        category: d.category, badgeColor: d.badgeColor, summary: d.summary, fileName: d.fileName, downloadUrl: d.downloadUrl,
        chapters: d.chapters.map((c) => ({ title: c.title, passages: c.verses.map((v) => ({ text: v.text, tags: [...v.tags], ...(v.pageNumber ? { pageNumber: v.pageNumber } : {}) })) })),
      };
    }).concat(locationsDoc()),
    sections: DEFAULT_SECTIONS.map((s) => ({ ...s, items: [...s.items] })),
  };
}

const BADGE = 'bg-slate-100 text-slate-900 border-slate-300';

/** Editable content → the documents the library shows (numbered chapters and passages with references). */
export function buildDocuments(content: LibraryContent): ProjectDocument[] {
  // passage ids must be unique across documents: a second "PAY" (an uploaded "Payment …" file) becomes "PAY2"
  const used = new Set<string>();
  return content.documents.map((d) => {
    let prefix = d.idPrefix || 'DOC';
    for (let n = 2; used.has(prefix); n++) prefix = `${d.idPrefix || 'DOC'}${n}`;
    used.add(prefix);
    const chapters = d.chapters.map((c, ci) => {
      const chapterNumber = ci + 1;
      const verses: DocVerse[] = c.passages.map((p, pi) => ({
        id: `${prefix}-${chapterNumber}:${pi + 1}`,
        docId: d.id, docTitle: d.refTitle || d.title, docShortName: d.refName, category: d.category,
        chapterNumber, chapterTitle: c.title, verseNumber: pi + 1,
        reference: `${d.refName} ${chapterNumber}:${pi + 1}`,
        text: p.text, tags: p.tags || [], ...(p.pageNumber ? { pageNumber: p.pageNumber } : {}),
      }));
      return { chapterNumber, title: c.title, verses };
    });
    return {
      id: d.id, title: d.title, shortName: d.shortName, category: d.category, badgeColor: d.badgeColor || BADGE, summary: d.summary,
      fileName: d.fileName, downloadUrl: d.downloadUrl, chapters, verses: chapters.flatMap((c) => c.verses),
    };
  });
}

