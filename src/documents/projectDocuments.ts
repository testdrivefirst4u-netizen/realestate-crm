export interface DocVerse {
  id: string; // e.g. "BRO-1:1"
  docId: string;
  docTitle: string;
  docShortName: string;
  category: 'Brochure' | 'Floor Plans' | 'Monthly Packages' | 'Pricing & Payment' | 'Legal & RERA';
  chapterNumber: number;
  chapterTitle: string;
  verseNumber: number;
  reference: string; // e.g. "Brochure 1:1"
  text: string;
  tags: string[];
  pageNumber?: number;
}

export interface DocChapter {
  chapterNumber: number;
  title: string;
  verses: DocVerse[];
}

export interface ProjectDocument {
  id: string;
  title: string;
  shortName: string;
  category: 'Brochure' | 'Floor Plans' | 'Monthly Packages' | 'Pricing & Payment' | 'Legal & RERA';
  badgeColor: string;
  summary: string;
  fileName: string;
  downloadUrl: string;
  chapters: DocChapter[];
  verses: DocVerse[];
}

export const PROJECT_DOCUMENTS: ProjectDocument[] = [
  {
    id: 'brochure',
    title: 'Amaya by Vera Vita — Master Project Overview & Brochure',
    shortName: 'Project Overview Brochure',
    category: 'Brochure',
    badgeColor: 'bg-amber-100 text-amber-900 border-amber-300',
    summary: 'Master 44-page overview featuring 13-acre development, 3 residential towers, Abin Design Studio architecture, Club Amaya amenities, and Medchal connectivity.',
    fileName: '1.Amaya by Vera Vita Project Overview.pdf',
    downloadUrl: '/documents/1.Amaya by Vera Vita Project Overview.md',
    chapters: [
      {
        chapterNumber: 1,
        title: 'Master Development Vision & Architecture',
        verses: [
          {
            id: 'BRO-1:1',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 1,
            chapterTitle: 'Master Development Vision & Architecture',
            verseNumber: 1,
            reference: 'Brochure 1:1',
            text: 'Amaya by Vera Vita is Hyderabad’s landmark luxury senior living sanctuary, conceived across a 13-acre private green enclave in Medchal. Phase 1 spans 3 pristine acres featuring three residential towers (Towers A, B, and C) rising Ground + 12 floors with 256 master-crafted residences.',
            tags: ['13 acres', 'Phase 1', '3 acres', 'Towers A B C', 'G+12', '256 units', 'luxury senior living', 'Medchal', 'Hyderabad'],
            pageNumber: 2,
          },
          {
            id: 'BRO-1:2',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 1,
            chapterTitle: 'Master Development Vision & Architecture',
            verseNumber: 2,
            reference: 'Brochure 1:2',
            text: 'Designed in collaboration with the award-winning Abin Design Studio, Amaya departs from clinical care environments to celebrate vibrant, active aging, multi-generational familial visits, and holistic wellness.',
            tags: ['Abin Design Studio', 'architecture', 'active aging', 'wellness', 'senior living'],
            pageNumber: 3,
          },
          {
            id: 'BRO-1:3',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 1,
            chapterTitle: 'Master Development Vision & Architecture',
            verseNumber: 3,
            reference: 'Brochure 1:3',
            text: 'Every square foot embodies 100% Vaastu compliance, uninhibited universal access, zero-threshold flooring, anti-skid vitrified tiles, and expansive views over the adjacent 700-acre Kandlakoya Reserve Forest.',
            tags: ['Vaastu compliant', 'zero-threshold', 'anti-skid', '700-acre', 'Kandlakoya Reserve Forest', 'universal access'],
            pageNumber: 4,
          },
        ],
      },
      {
        chapterNumber: 2,
        title: 'Strategic Location & Travel Connectivity',
        verses: [
          {
            id: 'BRO-2:1',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 2,
            chapterTitle: 'Strategic Location & Travel Connectivity',
            verseNumber: 1,
            reference: 'Brochure 2:1',
            text: 'Amaya is situated in Munirabad Village, Medchal Mandal, offering pristine air quality index (AQI) levels significantly superior to central urban Hyderabad while retaining rapid transit connections.',
            tags: ['Munirabad Village', 'Medchal Mandal', 'AQI', 'air quality', 'Hyderabad'],
            pageNumber: 6,
          },
          {
            id: 'BRO-2:2',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 2,
            chapterTitle: 'Strategic Location & Travel Connectivity',
            verseNumber: 2,
            reference: 'Brochure 2:2',
            text: 'Healthcare Proximity: Amaya is located just 12 minutes (7.8 km) from the premier MediCiti Institute of Medical Sciences & Hospital, ensuring tier-1 emergency medical backup and specialized inpatient care.',
            tags: ['MediCiti', 'MediCiti Hospital', 'MediCiti Institute of Medical Sciences', '12 mins', 'emergency care', '7.8 km'],
            pageNumber: 7,
          },
          {
            id: 'BRO-2:3',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 2,
            chapterTitle: 'Strategic Location & Travel Connectivity',
            verseNumber: 3,
            reference: 'Brochure 2:3',
            text: 'Arterial Connectivity: Located only 10 minutes from Outer Ring Road (ORR Exit 6), giving seamless signal-free access across Hyderabad and the airport.',
            tags: ['ORR', 'Outer Ring Road', 'Exit 6', '10 mins', 'connectivity'],
            pageNumber: 8,
          },
          {
            id: 'BRO-2:4',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 2,
            chapterTitle: 'Strategic Location & Travel Connectivity',
            verseNumber: 4,
            reference: 'Brochure 2:4',
            text: 'Transit Durations: Munirabad Town (5 mins), ORR Exit 6 (10 mins), MediCiti Hospital (12 mins), Kompally High Street (20 mins), Secunderabad Railway Station (50 mins), Gachibowli Financial District (60 mins), Rajiv Gandhi International Airport Shamshabad (70 mins).',
            tags: ['distances', 'transit', 'Kompally', 'Secunderabad', 'Gachibowli', 'Airport', 'Shamshabad'],
            pageNumber: 9,
          },
        ],
      },
      {
        chapterNumber: 3,
        title: 'Club Amaya — 35,000+ Sq.Ft Lifestyle Amenities',
        verses: [
          {
            id: 'BRO-3:1',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 3,
            chapterTitle: 'Club Amaya — 35,000+ Sq.Ft Lifestyle Amenities',
            verseNumber: 1,
            reference: 'Brochure 3:1',
            text: 'At the social heart of the community stands Club Amaya, an expansive 35,000+ square-foot multi-level clubhouse designed exclusively for residents and their visiting families.',
            tags: ['Club Amaya', '35000 sq ft', 'clubhouse', 'amenities'],
            pageNumber: 12,
          },
          {
            id: 'BRO-3:2',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 3,
            chapterTitle: 'Club Amaya — 35,000+ Sq.Ft Lifestyle Amenities',
            verseNumber: 2,
            reference: 'Brochure 3:2',
            text: 'Aquatic Therapy: Temperature-controlled indoor heated swimming pool equipped with gentle hydrotherapy massage jets and shallow ramp entry designed for senior comfort.',
            tags: ['heated pool', 'indoor swimming pool', 'hydrotherapy', 'aquatic therapy', 'swimming'],
            pageNumber: 14,
          },
          {
            id: 'BRO-3:3',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 3,
            chapterTitle: 'Club Amaya — 35,000+ Sq.Ft Lifestyle Amenities',
            verseNumber: 3,
            reference: 'Brochure 3:3',
            text: 'Movement & Fitness: Senior-ergonomic gymnasium with hydraulic pneumatic resistance machines, low-impact treadmills, and a separate timber-floored Yoga & Meditation deck.',
            tags: ['gym', 'fitness', 'pneumatic machines', 'yoga', 'meditation'],
            pageNumber: 16,
          },
          {
            id: 'BRO-3:4',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 3,
            chapterTitle: 'Club Amaya — 35,000+ Sq.Ft Lifestyle Amenities',
            verseNumber: 4,
            reference: 'Brochure 3:4',
            text: 'Entertainment & Culture: 50-seater acoustically treated Dolby audio screening theater with plush motorized recliners for private community movie nights and lectures.',
            tags: ['movie theater', 'cinema', 'screening theater', 'recliners', '50 seats'],
            pageNumber: 18,
          },
          {
            id: 'BRO-3:5',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 3,
            chapterTitle: 'Club Amaya — 35,000+ Sq.Ft Lifestyle Amenities',
            verseNumber: 5,
            reference: 'Brochure 3:5',
            text: 'Recreation & Landscapes: Curated library & business center, billiards, chess, golf simulator, Ayurvedic wellness spa, and 47,000 sq.ft of landscaped reflexology walking trails with organic herb nursery.',
            tags: ['library', 'business center', 'golf simulator', 'billiards', 'reflexology trails', '47000 sq ft', 'organic farming'],
            pageNumber: 20,
          },
        ],
      },
      {
        chapterNumber: 4,
        title: 'Universal Senior Engineering & Assistive Features',
        verses: [
          {
            id: 'BRO-4:1',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 4,
            chapterTitle: 'Universal Senior Engineering & Assistive Features',
            verseNumber: 1,
            reference: 'Brochure 4:1',
            text: 'Zero-Threshold Flooring: Entirely flush floor transitions between living rooms, bedrooms, sit-out balconies, and washrooms to eliminate tripping hazards for walking frames and wheelchairs.',
            tags: ['zero threshold', 'flush flooring', 'anti-skid', 'wheelchair accessible', 'safety'],
            pageNumber: 24,
          },
          {
            id: 'BRO-4:2',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 4,
            chapterTitle: 'Universal Senior Engineering & Assistive Features',
            verseNumber: 2,
            reference: 'Brochure 4:2',
            text: 'Emergency Response Alarms: Master bedrooms and all bathrooms are equipped with emergency panic buttons and pull-cords directly patched to the 24/7 campus triage nurse station.',
            tags: ['panic buttons', 'emergency pull cord', 'alarm', 'nurse station', 'intercom'],
            pageNumber: 26,
          },
          {
            id: 'BRO-4:3',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 4,
            chapterTitle: 'Universal Senior Engineering & Assistive Features',
            verseNumber: 3,
            reference: 'Brochure 4:3',
            text: 'Vertical & Campus Mobility: Two high-speed elevators per tower with slow-closing safety sensors and braille keys, plus a full-size medical stretcher elevator. Electric EV buggy cart service operates round-the-clock across campus.',
            tags: ['elevators', 'stretcher lift', 'EV buggy', 'golf cart', 'mobility'],
            pageNumber: 28,
          },
        ],
      },
      {
        chapterNumber: 5,
        title: 'On-Campus Healthcare, Physician Clinic & Ambulance',
        verses: [
          {
            id: 'BRO-5:1',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 5,
            chapterTitle: 'On-Campus Healthcare, Physician Clinic & Ambulance',
            verseNumber: 1,
            reference: 'Brochure 5:1',
            text: 'On-Campus Medical Pavilion: Staffed 24 hours a day by registered geriatric nursing personnel and emergency medical technicians with a fully stocked critical medication repository.',
            tags: ['medical center', 'geriatric nurse', '24/7 care', 'healthcare', 'emergency'],
            pageNumber: 32,
          },
          {
            id: 'BRO-5:2',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 5,
            chapterTitle: 'On-Campus Healthcare, Physician Clinic & Ambulance',
            verseNumber: 2,
            reference: 'Brochure 5:2',
            text: 'Dedicated Ambulance: Amaya maintains an exclusive Advanced Cardiac Life Support (ACLS) ambulance stationed permanently on-site for immediate transfer to MediCiti Hospital or other apex trauma centers.',
            tags: ['ambulance', 'ACLS', 'MediCiti', 'paramedic', 'cardiac support'],
            pageNumber: 34,
          },
          {
            id: 'BRO-5:3',
            docId: 'brochure',
            docTitle: 'Amaya Master Project Overview & Brochure',
            docShortName: 'Brochure',
            category: 'Brochure',
            chapterNumber: 5,
            chapterTitle: 'On-Campus Healthcare, Physician Clinic & Ambulance',
            verseNumber: 3,
            reference: 'Brochure 5:3',
            text: 'Physiotherapy & Health Records: Comprehensive physiotherapy clinic for stroke recovery, joint stiffness, and balance conditioning, coupled with digitized confidential health records for every resident.',
            tags: ['physiotherapy', 'health records', 'rehabilitation', 'doctor visits'],
            pageNumber: 36,
          },
        ],
      },
    ],
    verses: [],
  },
  {
    id: 'floor-plans',
    title: 'Amaya by Vera Vita — Floor Plans & Unit Layout Directory',
    shortName: 'Floor Plans & Layouts',
    category: 'Floor Plans',
    badgeColor: 'bg-emerald-100 text-emerald-900 border-emerald-300',
    summary: 'Complete architectural floor plans, carpet areas, total built-up dimensions, and UDS details for 1 BHK, 2 BHK, 2.5 BHK, 3 BHK, and 3.5 BHK units across Towers A, B, and C.',
    fileName: '2.Amaya by Vera Vita Floor Plans.pdf',
    downloadUrl: '/documents/2.Amaya by Vera Vita Floor Plans.md',
    chapters: [
      {
        chapterNumber: 1,
        title: '1 BHK Senior Living Residences',
        verses: [
          {
            id: 'FLP-1:1',
            docId: 'floor-plans',
            docTitle: 'Amaya Floor Plans & Unit Layout Directory',
            docShortName: 'Floor Plans',
            category: 'Floor Plans',
            chapterNumber: 1,
            chapterTitle: '1 BHK Senior Living Residences',
            verseNumber: 1,
            reference: 'Floor Plans 1:1',
            text: '1 BHK Type A (Towers B & C): Carpet Area: 691.90 sq.ft (64.28 sq.m), Balcony & Utility: 49.30 sq.ft, Total Super Built-up Area: 953.21 sq.ft (88.55 sq.m), Undivided Share (UDS): 34.33 sq.yards. Dimensions: Living & Dining: 11\'6" x 19\'0", Master Bedroom: 12\'0" x 13\'6", Senior Bathroom: 8\'0" x 6\'0".',
            tags: ['1 BHK', '1 BHK Type A', '691.90', '953.21', 'UDS 34.33', 'Towers B and C'],
            pageNumber: 4,
          },
          {
            id: 'FLP-1:2',
            docId: 'floor-plans',
            docTitle: 'Amaya Floor Plans & Unit Layout Directory',
            docShortName: 'Floor Plans',
            category: 'Floor Plans',
            chapterNumber: 1,
            chapterTitle: '1 BHK Senior Living Residences',
            verseNumber: 2,
            reference: 'Floor Plans 1:2',
            text: '1 BHK Type B (Towers A, B & C): Carpet Area: 737.27 sq.ft (68.49 sq.m), Balcony & Utility: 54.10 sq.ft, Total Super Built-up Area: 1,015.72 sq.ft (94.36 sq.m), Undivided Share (UDS): 36.58 sq.yards. Features morning east sunlight and walk-in dressing zone.',
            tags: ['1 BHK', '1 BHK Type B', '737.27', '1015.72', 'UDS 36.58', 'Towers A B C'],
            pageNumber: 5,
          },
        ],
      },
      {
        chapterNumber: 2,
        title: '2 BHK Luxury Residences',
        verses: [
          {
            id: 'FLP-2:1',
            docId: 'floor-plans',
            docTitle: 'Amaya Floor Plans & Unit Layout Directory',
            docShortName: 'Floor Plans',
            category: 'Floor Plans',
            chapterNumber: 2,
            chapterTitle: '2 BHK Luxury Residences',
            verseNumber: 1,
            reference: 'Floor Plans 2:1',
            text: '2 BHK Type A (Towers A, B & C): Carpet Area: 1,112.94 sq.ft (103.39 sq.m), Balcony & Utility: 88.50 sq.ft, Total Super Built-up Area: 1,533.28 sq.ft (142.44 sq.m), Undivided Share (UDS): 55.22 sq.yards. Spacious 13\'0" x 23\'6" living hall, 2 adapted bathrooms, master suite (13\'0" x 15\'0").',
            tags: ['2 BHK', '2 BHK Type A', '1112.94', '1533.28', 'UDS 55.22', 'Towers A B C'],
            pageNumber: 8,
          },
          {
            id: 'FLP-2:2',
            docId: 'floor-plans',
            docTitle: 'Amaya Floor Plans & Unit Layout Directory',
            docShortName: 'Floor Plans',
            category: 'Floor Plans',
            chapterNumber: 2,
            chapterTitle: '2 BHK Luxury Residences',
            verseNumber: 2,
            reference: 'Floor Plans 2:2',
            text: '2 BHK Type B (Towers A, B & C): Carpet Area: 1,107.21 sq.ft (102.86 sq.m), Balcony & Utility: 86.40 sq.ft, Total Super Built-up Area: 1,525.38 sq.ft (141.71 sq.m), Undivided Share (UDS): 54.94 sq.yards. Corner orientation with cross ventilation and modular open kitchen.',
            tags: ['2 BHK', '2 BHK Type B', '1107.21', '1525.38', 'UDS 54.94', 'cross ventilation'],
            pageNumber: 9,
          },
        ],
      },
      {
        chapterNumber: 3,
        title: '2.5 BHK Residences with Study / Puja Room',
        verses: [
          {
            id: 'FLP-3:1',
            docId: 'floor-plans',
            docTitle: 'Amaya Floor Plans & Unit Layout Directory',
            docShortName: 'Floor Plans',
            category: 'Floor Plans',
            chapterNumber: 3,
            chapterTitle: '2.5 BHK Residences with Study / Puja Room',
            verseNumber: 1,
            reference: 'Floor Plans 3:1',
            text: '2.5 BHK Type A (Towers A, B & C): Carpet Area: 1,231.08 sq.ft (114.37 sq.m), Balcony & Utility: 104.20 sq.ft, Total Super Built-up Area: 1,696.03 sq.ft (157.56 sq.m), Undivided Share (UDS): 61.09 sq.yards. Includes dedicated 8\'6" x 9\'0" multi-utility room (puja/study/guest) and dual balconies.',
            tags: ['2.5 BHK', '2.5 BHK Type A', '1231.08', '1696.03', 'UDS 61.09', 'puja room', 'study'],
            pageNumber: 12,
          },
          {
            id: 'FLP-3:2',
            docId: 'floor-plans',
            docTitle: 'Amaya Floor Plans & Unit Layout Directory',
            docShortName: 'Floor Plans',
            category: 'Floor Plans',
            chapterNumber: 3,
            chapterTitle: '2.5 BHK Residences with Study / Puja Room',
            verseNumber: 2,
            reference: 'Floor Plans 3:2',
            text: '2.5 BHK Type B (Towers A, B & C): Carpet Area: 1,256.48 sq.ft (116.73 sq.m), Balcony & Utility: 108.60 sq.ft, Total Super Built-up Area: 1,731.03 sq.ft (160.81 sq.m), Undivided Share (UDS): 62.35 sq.yards. Expansive eat-in kitchen with private breakfast bar and east view.',
            tags: ['2.5 BHK', '2.5 BHK Type B', '1256.48', '1731.03', 'UDS 62.35', 'east facing'],
            pageNumber: 13,
          },
        ],
      },
      {
        chapterNumber: 4,
        title: '3 BHK & 3.5 BHK Signature Residences',
        verses: [
          {
            id: 'FLP-4:1',
            docId: 'floor-plans',
            docTitle: 'Amaya Floor Plans & Unit Layout Directory',
            docShortName: 'Floor Plans',
            category: 'Floor Plans',
            chapterNumber: 4,
            chapterTitle: '3 BHK & 3.5 BHK Signature Residences',
            verseNumber: 1,
            reference: 'Floor Plans 4:1',
            text: '3 BHK Signature (Towers A, B & C): Carpet Area: 1,548.72 sq.ft (143.88 sq.m), Balcony & Utility: 135.20 sq.ft, Total Super Built-up Area: 2,133.65 sq.ft (198.22 sq.m), Undivided Share (UDS): 76.85 sq.yards. Three lavish bedrooms, 3 full bathrooms, powder toilet, and double balcony with 180° views of Kandlakoya Forest.',
            tags: ['3 BHK', '1548.72', '2133.65', 'UDS 76.85', 'forest view', 'Kandlakoya'],
            pageNumber: 16,
          },
          {
            id: 'FLP-4:2',
            docId: 'floor-plans',
            docTitle: 'Amaya Floor Plans & Unit Layout Directory',
            docShortName: 'Floor Plans',
            category: 'Floor Plans',
            chapterNumber: 4,
            chapterTitle: '3 BHK & 3.5 BHK Signature Residences',
            verseNumber: 2,
            reference: 'Floor Plans 4:2',
            text: '3.5 BHK Presidential (Tower A Exclusive): Carpet Area: 1,782.63 sq.ft (165.61 sq.m), Balcony & Utility: 162.80 sq.ft, Total Super Built-up Area: 2,455.89 sq.ft (228.16 sq.m), Undivided Share (UDS): 88.45 sq.yards. Features dedicated attendant suite, private foyer, 4 bathrooms, wrap-around sunset deck.',
            tags: ['3.5 BHK', '1782.63', '2455.89', 'UDS 88.45', 'Tower A exclusive', 'presidential'],
            pageNumber: 18,
          },
        ],
      },
      {
        chapterNumber: 5,
        title: 'Building Finishes & Engineering Specifications',
        verses: [
          {
            id: 'FLP-5:1',
            docId: 'floor-plans',
            docTitle: 'Amaya Floor Plans & Unit Layout Directory',
            docShortName: 'Floor Plans',
            category: 'Floor Plans',
            chapterNumber: 5,
            chapterTitle: 'Building Finishes & Engineering Specifications',
            verseNumber: 1,
            reference: 'Floor Plans 5:1',
            text: 'Flooring Specifications: 800 x 800 mm matte-finish anti-skid vitrified tiles across living, dining, and bedrooms. Non-slippery rustic ceramic tiles in all balconies and washrooms with zero threshold thresholds.',
            tags: ['800x800', 'anti-skid vitrified', 'flooring specifications', 'zero threshold'],
            pageNumber: 22,
          },
          {
            id: 'FLP-5:2',
            docId: 'floor-plans',
            docTitle: 'Amaya Floor Plans & Unit Layout Directory',
            docShortName: 'Floor Plans',
            category: 'Floor Plans',
            chapterNumber: 5,
            chapterTitle: 'Building Finishes & Engineering Specifications',
            verseNumber: 2,
            reference: 'Floor Plans 5:2',
            text: 'Sanitary & Electrical: Premium Kohler / Grohe fixtures, wall-hung EWCs with soft-close seats, grab rails, thermostatic diverters with anti-scald temperature limiter. Legrand modular switches and 100% full DG power backup.',
            tags: ['Kohler', 'Grohe', 'grab rails', 'anti-scald', 'DG backup', 'electrical'],
            pageNumber: 24,
          },
        ],
      },
    ],
    verses: [],
  },
  {
    id: 'monthly-packages',
    title: 'Amaya by Vera Vita — Monthly Assisted Living & Maintenance Packages',
    shortName: 'Monthly Care & Food Packages',
    category: 'Monthly Packages',
    badgeColor: 'bg-rose-100 text-rose-900 border-rose-300',
    summary: 'Comprehensive breakdown of monthly food tiers (₹12,500 veg / ₹15,000 non-veg), housekeeping, 24/7 nursing, laundry, CAM, and unit-wise combined tariffs.',
    fileName: '3.Amaya Monthly Packages.pdf',
    downloadUrl: '/documents/3.Amaya Monthly Packages.md',
    chapters: [
      {
        chapterNumber: 1,
        title: 'Estate CAM & Infrastructure Management',
        verses: [
          {
            id: 'PKG-1:1',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 1,
            chapterTitle: 'Estate CAM & Infrastructure Management',
            verseNumber: 1,
            reference: 'Packages 1:1',
            text: 'Common Area Maintenance (CAM): 24/7 gate security forces, 120+ CCTV surveillance network, concierge reception, garden upkeep across 47,000 sq.ft, lift AMCs, power backup diesel operation, and central RO water purification.',
            tags: ['CAM', 'common area maintenance', 'security', 'CCTV', 'concierge', 'gardening'],
            pageNumber: 2,
          },
          {
            id: 'PKG-1:2',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 1,
            chapterTitle: 'Estate CAM & Infrastructure Management',
            verseNumber: 2,
            reference: 'Packages 1:2',
            text: 'Internal Mobility: Unlimited on-demand electric buggy transportation shuttling residents between towers, Clubhouse Amaya, the medical pavilion, and gate security.',
            tags: ['buggy', 'electric golf cart', 'shuttle', 'internal transport'],
            pageNumber: 3,
          },
        ],
      },
      {
        chapterNumber: 2,
        title: 'Housekeeping, Sanitization & Laundry Services',
        verses: [
          {
            id: 'PKG-2:1',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 2,
            chapterTitle: 'Housekeeping, Sanitization & Laundry Services',
            verseNumber: 1,
            reference: 'Packages 2:1',
            text: 'Daily Housekeeping: Thorough daily dusting, sweeping, wet-mopping with anti-bacterial eco-friendly solutions, and apartment waste disposal by trained hospitality personnel.',
            tags: ['daily housekeeping', 'cleaning', 'mopping', 'waste disposal'],
            pageNumber: 5,
          },
          {
            id: 'PKG-2:2',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 2,
            chapterTitle: 'Housekeeping, Sanitization & Laundry Services',
            verseNumber: 2,
            reference: 'Packages 2:2',
            text: 'Laundry & Ironing Concierge: Bi-weekly bed linen, towels, and pillow cover wash turnaround. Personal garments washed, folded, and steam-ironed with direct delivery to wardrobes.',
            tags: ['laundry', 'ironing', 'linen change', 'concierge'],
            pageNumber: 6,
          },
        ],
      },
      {
        chapterNumber: 3,
        title: 'Healthcare, Nursing & Medical Emergency Tariffs',
        verses: [
          {
            id: 'PKG-3:1',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 3,
            chapterTitle: 'Healthcare, Nursing & Medical Emergency Tariffs',
            verseNumber: 1,
            reference: 'Packages 3:1',
            text: '24/7 Geriatric Nursing: On-campus registered nurses available 24/7 for vitals checks (blood pressure, pulse, SpO2, blood sugar), routine injections, wound dressing, and emergency triage response.',
            tags: ['24/7 nursing', 'vitals check', 'blood pressure', 'blood sugar', 'injections'],
            pageNumber: 8,
          },
          {
            id: 'PKG-3:2',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 3,
            chapterTitle: 'Healthcare, Nursing & Medical Emergency Tariffs',
            verseNumber: 2,
            reference: 'Packages 3:2',
            text: 'Emergency Ambulance: Dedicated on-campus Advanced Cardiac Life Support (ACLS) ambulance stationed at Amaya 24/7 for immediate transfer to MediCiti Multi-speciality Hospital (12 mins away).',
            tags: ['ambulance', 'MediCiti', 'emergency', 'ACLS', 'transfer'],
            pageNumber: 9,
          },
        ],
      },
      {
        chapterNumber: 4,
        title: 'Dining & Nutrition Meal Packages',
        verses: [
          {
            id: 'PKG-4:1',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 4,
            chapterTitle: 'Dining & Nutrition Meal Packages',
            verseNumber: 1,
            reference: 'Packages 4:1',
            text: 'Pure Vegetarian Meal Package: ₹12,500 per resident per month. Includes 4 curated meals daily: morning bed tea/coffee with biscuits, hot buffet breakfast, 4-course lunch, high tea with evening savories, and wholesome dinner.',
            tags: ['food package', 'vegetarian', '12500', 'meals', 'breakfast', 'lunch', 'dinner'],
            pageNumber: 11,
          },
          {
            id: 'PKG-4:2',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 4,
            chapterTitle: 'Dining & Nutrition Meal Packages',
            verseNumber: 2,
            reference: 'Packages 4:2',
            text: 'Non-Vegetarian Meal Package: ₹15,000 per resident per month. Includes the full vegetarian menu plus fresh chicken, fish, and egg delicacies served 4 to 5 times per week.',
            tags: ['food package', 'non-vegetarian', '15000', 'chicken', 'fish', 'eggs'],
            pageNumber: 12,
          },
          {
            id: 'PKG-4:3',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 4,
            chapterTitle: 'Dining & Nutrition Meal Packages',
            verseNumber: 3,
            reference: 'Packages 4:3',
            text: 'Dietary Customization: Diabetic-tailored low GI grains, low-sodium hypertension diets, pure Jain, gluten-free, and doctor-prescribed recuperation diets prepared at zero extra charge.',
            tags: ['diabetic', 'low sodium', 'Jain', 'dietary customization', 'gluten free'],
            pageNumber: 13,
          },
        ],
      },
      {
        chapterNumber: 5,
        title: 'Consolidated Monthly Living Package Rates',
        verses: [
          {
            id: 'PKG-5:1',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 5,
            chapterTitle: 'Consolidated Monthly Living Package Rates',
            verseNumber: 1,
            reference: 'Packages 5:1',
            text: '1 BHK Combined Monthly Living Package: Single Occupancy: ₹23,131 / month | Couple Occupancy: ₹32,538 / month. Includes CAM, daily housekeeping, bi-weekly laundry, complete dining package, and 24/7 nursing and ambulance backup.',
            tags: ['1 BHK package', '23131', '32538', 'single', 'couple', 'monthly package'],
            pageNumber: 15,
          },
          {
            id: 'PKG-5:2',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 5,
            chapterTitle: 'Consolidated Monthly Living Package Rates',
            verseNumber: 2,
            reference: 'Packages 5:2',
            text: '2 BHK Combined Monthly Living Package: Single Occupancy: ₹31,482 / month | Couple Occupancy: ₹40,889 / month.',
            tags: ['2 BHK package', '31482', '40889', 'single', 'couple', 'monthly package'],
            pageNumber: 16,
          },
          {
            id: 'PKG-5:3',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 5,
            chapterTitle: 'Consolidated Monthly Living Package Rates',
            verseNumber: 3,
            reference: 'Packages 5:3',
            text: '3 BHK Combined Monthly Living Package: Single Occupancy: ₹40,126 / month | Couple Occupancy: ₹49,533 / month.',
            tags: ['3 BHK package', '40126', '49533', 'single', 'couple', 'monthly package'],
            pageNumber: 17,
          },
          {
            id: 'PKG-5:4',
            docId: 'monthly-packages',
            docTitle: 'Amaya Monthly Assisted Living Packages',
            docShortName: 'Packages',
            category: 'Monthly Packages',
            chapterNumber: 5,
            chapterTitle: 'Consolidated Monthly Living Package Rates',
            verseNumber: 4,
            reference: 'Packages 5:4',
            text: 'Specialized Care Add-ons: 12-hour dedicated bedside attendant: ₹18,000–₹22,000 / month; 24-hour live-in caregiver: ₹32,000–₹38,000 / month; Dementia & memory care day support: ₹8,000 / month.',
            tags: ['bedside caregiver', 'dementia care', 'live-in attendant', 'specialized care'],
            pageNumber: 18,
          },
        ],
      },
    ],
    verses: [],
  },
  {
    id: 'payment-schedule',
    title: 'Amaya by Vera Vita — Payment Schedule & Construction Milestones',
    shortName: 'Payment Schedule & Milestones',
    category: 'Pricing & Payment',
    badgeColor: 'bg-blue-100 text-blue-900 border-blue-300',
    summary: 'Construction-linked 10-stage payment schedule (10% per milestone), BSP ₹8,999/sqft, car park ₹2.5L, corpus fund ₹200/sqft, taxes, and bank pre-approvals.',
    fileName: 'Amaya Payment Schedule.pdf',
    downloadUrl: '/documents/Amaya Payment Schedule.md',
    chapters: [
      {
        chapterNumber: 1,
        title: 'Pricing Matrix & Base Tariffs',
        verses: [
          {
            id: 'PAY-1:1',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 1,
            chapterTitle: 'Pricing Matrix & Base Tariffs',
            verseNumber: 1,
            reference: 'Payment Schedule 1:1',
            text: 'Basic Sale Price (BSP): ₹8,999 per sq.ft of total super built-up area across all towers and configurations.',
            tags: ['BSP', 'Basic Sale Price', '8999', 'rate per sqft', 'pricing'],
            pageNumber: 2,
          },
          {
            id: 'PAY-1:2',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 1,
            chapterTitle: 'Pricing Matrix & Base Tariffs',
            verseNumber: 2,
            reference: 'Payment Schedule 1:2',
            text: 'Car Parking Slot: ₹2,50,000 per designated covered basement or podium parking space.',
            tags: ['car park', 'parking', '250000', '2.5L', 'basement parking'],
            pageNumber: 3,
          },
          {
            id: 'PAY-1:3',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 1,
            chapterTitle: 'Pricing Matrix & Base Tariffs',
            verseNumber: 3,
            reference: 'Payment Schedule 1:3',
            text: 'Corpus Fund (Sinking Reserve): ₹200 per sq.ft of super built-up area payable at handover for long-term capital replacement reserves.',
            tags: ['corpus fund', '200', 'sinking fund', 'reserve fund'],
            pageNumber: 4,
          },
          {
            id: 'PAY-1:4',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 1,
            chapterTitle: 'Pricing Matrix & Base Tariffs',
            verseNumber: 4,
            reference: 'Payment Schedule 1:4',
            text: 'Statutory Taxes & Levies: Goods and Services Tax (GST) is 5% on construction stages. Registration & Stamp Duty is 7.5% payable directly upon execution of Sale Deed. TDS is 1% under Section 194-IA.',
            tags: ['GST 5%', 'stamp duty 7.5%', 'registration', 'taxes', 'TDS 1%'],
            pageNumber: 5,
          },
        ],
      },
      {
        chapterNumber: 2,
        title: '10-Stage Construction-Linked Payment Milestones',
        verses: [
          {
            id: 'PAY-2:1',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 2,
            chapterTitle: '10-Stage Construction-Linked Payment Milestones',
            verseNumber: 1,
            reference: 'Payment Schedule 2:1',
            text: 'Milestone 1 — Booking Advance: 10% of total unit agreement value payable on submission of booking application.',
            tags: ['Milestone 1', 'booking token', '10%', 'application'],
            pageNumber: 6,
          },
          {
            id: 'PAY-2:2',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 2,
            chapterTitle: '10-Stage Construction-Linked Payment Milestones',
            verseNumber: 2,
            reference: 'Payment Schedule 2:2',
            text: 'Milestone 2 — Agreement of Sale: 10% payable within 30 days of booking upon execution of formal Agreement of Sale.',
            tags: ['Milestone 2', 'Agreement of Sale', '10%', '30 days'],
            pageNumber: 7,
          },
          {
            id: 'PAY-2:3',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 2,
            chapterTitle: '10-Stage Construction-Linked Payment Milestones',
            verseNumber: 3,
            reference: 'Payment Schedule 2:3',
            text: 'Milestone 3 — Foundation & Raft: 10% payable on completion of foundation, piling, and raft slab of the respective tower.',
            tags: ['Milestone 3', 'foundation', 'raft', '10%'],
            pageNumber: 8,
          },
          {
            id: 'PAY-2:4',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 2,
            chapterTitle: '10-Stage Construction-Linked Payment Milestones',
            verseNumber: 4,
            reference: 'Payment Schedule 2:4',
            text: 'Milestones 4 to 8 — Slabs: 10% on Basements completion; 10% on 3rd Floor Slab; 10% on 6th Floor Slab; 10% on 9th Floor Slab; 10% on 12th Floor Roof / Terrace Slab.',
            tags: ['Milestone 4', 'Milestone 5', 'Milestone 6', 'Milestone 7', 'Milestone 8', 'slabs', '3rd floor', '6th floor', '9th floor', '12th floor', 'terrace'],
            pageNumber: 9,
          },
          {
            id: 'PAY-2:5',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 2,
            chapterTitle: '10-Stage Construction-Linked Payment Milestones',
            verseNumber: 5,
            reference: 'Payment Schedule 2:5',
            text: 'Milestones 9 & 10 — Finishing & Handover: 10% on completion of internal brickwork, plastering, and flooring; final 10% on notice of possession and key handover along with corpus fund and registration.',
            tags: ['Milestone 9', 'Milestone 10', 'handover', 'possession', 'brickwork', 'plastering', '10%'],
            pageNumber: 10,
          },
        ],
      },
      {
        chapterNumber: 3,
        title: 'All-Inclusive Unit Outlays & Bank Loan Tie-ups',
        verses: [
          {
            id: 'PAY-3:1',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 3,
            chapterTitle: 'All-Inclusive Unit Outlays & Bank Loan Tie-ups',
            verseNumber: 1,
            reference: 'Payment Schedule 3:1',
            text: 'Unit All-Inclusive Cost Breakdown: 1 BHK-A (953.21 sq.ft): Approx ₹1,00,90,821; 2 BHK-A (1,533.28 sq.ft): Approx ₹1,60,79,391; 2.5 BHK-A (1,696.03 sq.ft): Approx ₹1,77,53,600; 3 BHK (2,133.65 sq.ft): Approx ₹2,22,77,536; 3.5 BHK (2,455.89 sq.ft): Approx ₹2,56,04,301.',
            tags: ['10090821', '16079391', '17753600', '22277536', '25604301', 'all inclusive', 'cost sheet'],
            pageNumber: 12,
          },
          {
            id: 'PAY-3:2',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 3,
            chapterTitle: 'All-Inclusive Unit Outlays & Bank Loan Tie-ups',
            verseNumber: 2,
            reference: 'Payment Schedule 3:2',
            text: 'Institutional Home Loans: Pre-approved by State Bank of India (SBI), HDFC Bank, ICICI Bank, and Axis Bank for home loans up to 80% financing with senior co-applicant eligibility.',
            tags: ['home loans', 'SBI', 'HDFC', 'ICICI', 'Axis Bank', '80% loan', 'bank approvals'],
            pageNumber: 14,
          },
          {
            id: 'PAY-3:3',
            docId: 'payment-schedule',
            docTitle: 'Amaya Payment Schedule & Pricing Matrix',
            docShortName: 'Payment Schedule',
            category: 'Pricing & Payment',
            chapterNumber: 3,
            chapterTitle: 'All-Inclusive Unit Outlays & Bank Loan Tie-ups',
            verseNumber: 3,
            reference: 'Payment Schedule 3:3',
            text: 'Token Refund Policy: 100% full refund of token advance within 15 calendar days if the applicant opts not to proceed prior to execution of Agreement of Sale.',
            tags: ['token refund', '15 days', 'refund policy', 'booking advance'],
            pageNumber: 15,
          },
        ],
      },
    ],
    verses: [],
  },
  {
    id: 'legal-rera',
    title: 'Amaya by Vera Vita — Legal Clearances & RERA Documentation',
    shortName: 'Legal Clearances & RERA',
    category: 'Legal & RERA',
    badgeColor: 'bg-purple-100 text-purple-900 border-purple-300',
    summary: 'RERA Registration No. TG RERA P02200011109, 30-year clear title, non-agricultural land conversion, Fire NOC, SEIAA Environmental Clearance, and senior living model agreements.',
    fileName: 'Amaya Legal Approvals & RERA Documentation.pdf',
    downloadUrl: '/documents/Amaya Legal Approvals & RERA Documentation.md',
    chapters: [
      {
        chapterNumber: 1,
        title: 'TG RERA Registration & Escrow Protections',
        verses: [
          {
            id: 'LEG-1:1',
            docId: 'legal-rera',
            docTitle: 'Amaya Legal Clearances & RERA Documentation',
            docShortName: 'Legal & RERA',
            category: 'Legal & RERA',
            chapterNumber: 1,
            chapterTitle: 'TG RERA Registration & Escrow Protections',
            verseNumber: 1,
            reference: 'Legal & RERA 1:1',
            text: 'TG RERA Registration Certificate: Amaya Phase 1 is officially registered under the Telangana Real Estate Regulatory Authority with registration number TG RERA P02200011109, valid through December 31, 2028.',
            tags: ['TG RERA', 'P02200011109', 'RERA registration', 'validity 2028', 'sanction'],
            pageNumber: 2,
          },
          {
            id: 'LEG-1:2',
            docId: 'legal-rera',
            docTitle: 'Amaya Legal Clearances & RERA Documentation',
            docShortName: 'Legal & RERA',
            category: 'Legal & RERA',
            chapterNumber: 1,
            chapterTitle: 'TG RERA Registration & Escrow Protections',
            verseNumber: 2,
            reference: 'Legal & RERA 1:2',
            text: 'Statutory Escrow Account: In strict compliance with Section 4(2)(l)(D) of the RERA Act, 70% of all customer funds are deposited directly into a designated project escrow account reserved exclusively for Amaya construction and land development.',
            tags: ['escrow account', '70%', 'RERA Act', 'buyer protection', 'construction fund'],
            pageNumber: 3,
          },
        ],
      },
      {
        chapterNumber: 2,
        title: 'Land Title, Survey Numbers & Conversions',
        verses: [
          {
            id: 'LEG-2:1',
            docId: 'legal-rera',
            docTitle: 'Amaya Legal Clearances & RERA Documentation',
            docShortName: 'Legal & RERA',
            category: 'Legal & RERA',
            chapterNumber: 2,
            chapterTitle: 'Land Title, Survey Numbers & Conversions',
            verseNumber: 1,
            reference: 'Legal & RERA 2:1',
            text: 'Clear Marketable Freehold Title: 13 Acres of prime land situated in Survey Nos. 142/A, 143/1 & 144, Munirabad Village, Medchal Mandal, Medchal-Malkajgiri District, certified through a 30-year non-encumbrance legal scrutiny report by senior High Court advocates.',
            tags: ['Survey Nos 142/A 143/1 144', 'Munirabad Village', '13 acres', 'freehold title', '30 year search', 'encumbrance certificate'],
            pageNumber: 4,
          },
          {
            id: 'LEG-2:2',
            docId: 'legal-rera',
            docTitle: 'Amaya Legal Clearances & RERA Documentation',
            docShortName: 'Legal & RERA',
            category: 'Legal & RERA',
            chapterNumber: 2,
            chapterTitle: 'Land Title, Survey Numbers & Conversions',
            verseNumber: 2,
            reference: 'Legal & RERA 2:2',
            text: 'Non-Agricultural Land Conversion: Formal land use conversion certificate granted by the Revenue Department / District Collectorate for development of residential senior living habitat.',
            tags: ['non-agricultural conversion', 'revenue department', 'land clearance'],
            pageNumber: 5,
          },
        ],
      },
      {
        chapterNumber: 3,
        title: 'Statutory NOCs, Environmental & Fire Approvals',
        verses: [
          {
            id: 'LEG-3:1',
            docId: 'legal-rera',
            docTitle: 'Amaya Legal Clearances & RERA Documentation',
            docShortName: 'Legal & RERA',
            category: 'Legal & RERA',
            chapterNumber: 3,
            chapterTitle: 'Statutory NOCs, Environmental & Fire Approvals',
            verseNumber: 1,
            reference: 'Legal & RERA 3:1',
            text: 'Environmental Clearance (EC): Granted by the State Level Environment Impact Assessment Authority (SEIAA), Telangana, certifying zero-effluent discharge, rainwater harvesting recharge wells, and STP.',
            tags: ['environmental clearance', 'SEIAA', 'pollution control board', 'STP', 'rainwater'],
            pageNumber: 6,
          },
          {
            id: 'LEG-3:2',
            docId: 'legal-rera',
            docTitle: 'Amaya Legal Clearances & RERA Documentation',
            docShortName: 'Legal & RERA',
            category: 'Legal & RERA',
            chapterNumber: 3,
            chapterTitle: 'Statutory NOCs, Environmental & Fire Approvals',
            verseNumber: 2,
            reference: 'Legal & RERA 3:2',
            text: 'Fire Department NOC: Issued by Telangana State Disaster Response and Fire Services Department for Ground + 12 floors including dual pressurized emergency staircases and automatic sprinklers.',
            tags: ['fire NOC', 'fire safety', 'staircases', 'sprinklers', 'disaster response'],
            pageNumber: 7,
          },
          {
            id: 'LEG-3:3',
            docId: 'legal-rera',
            docTitle: 'Amaya Legal Clearances & RERA Documentation',
            docShortName: 'Legal & RERA',
            category: 'Legal & RERA',
            chapterNumber: 3,
            chapterTitle: 'Statutory NOCs, Environmental & Fire Approvals',
            verseNumber: 3,
            reference: 'Legal & RERA 3:3',
            text: 'Airport Height NOC: Unconditional height clearance granted by Airports Authority of India (AAI) for structural height up to 48.5 meters above ground level.',
            tags: ['AAI', 'airport height NOC', '48.5 meters', 'clearance'],
            pageNumber: 8,
          },
        ],
      },
      {
        chapterNumber: 4,
        title: 'Senior Housing Guidelines & Resident Bylaws',
        verses: [
          {
            id: 'LEG-4:1',
            docId: 'legal-rera',
            docTitle: 'Amaya Legal Clearances & RERA Documentation',
            docShortName: 'Legal & RERA',
            category: 'Legal & RERA',
            chapterNumber: 4,
            chapterTitle: 'Senior Housing Guidelines & Resident Bylaws',
            verseNumber: 1,
            reference: 'Legal & RERA 4:1',
            text: 'Ministry Guidelines Compliance: Sale deeds and operations operate under the Model Guidelines for Development and Regulation of Retirement Homes issued by the Ministry of Housing and Urban Affairs (MoHUA).',
            tags: ['MoHUA', 'Ministry guidelines', 'retirement homes', 'senior housing regulations'],
            pageNumber: 9,
          },
          {
            id: 'LEG-4:2',
            docId: 'legal-rera',
            docTitle: 'Amaya Legal Clearances & RERA Documentation',
            docShortName: 'Legal & RERA',
            category: 'Legal & RERA',
            chapterNumber: 4,
            chapterTitle: 'Senior Housing Guidelines & Resident Bylaws',
            verseNumber: 2,
            reference: 'Legal & RERA 4:2',
            text: 'Occupant Age Criteria: The primary registered resident or at least one joint occupant must be 55 years of age or above at the commencement of occupancy. Guests, visiting children, and grandchildren can reside for up to 60 consecutive days.',
            tags: ['age criteria', '55 years', 'senior citizen', 'guest policy', '60 days'],
            pageNumber: 10,
          },
        ],
      },
    ],
    verses: [],
  },
];

// Flatten all verses for rapid search
PROJECT_DOCUMENTS.forEach((doc) => {
  doc.verses = doc.chapters.flatMap((c) => c.verses);
});

export const ALL_DOC_VERSES: DocVerse[] = PROJECT_DOCUMENTS.flatMap((d) => d.verses);

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (s: string) => String(s).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
const MARK_OPEN = '<mark class="bg-[#C89D66]/30 text-[#1D2F3F] font-bold px-1 rounded-xs border-b border-[#A9825A]">';

/**
 * `text` as HTML with every term wrapped in <mark>. The text is escaped first and all terms are matched in one
 * pass, so neither the document nor the (user-typed) terms can inject markup or match inside an earlier <mark>.
 */
export function highlightTerms(text: string, terms: string[]): string {
  const safe = escapeHtml(text);
  const parts = terms.map((t) => escapeHtml(String(t || '').trim())).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!parts.length) return safe;
  const re = new RegExp(`(${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return safe.replace(re, `${MARK_OPEN}$1</mark>`);
}

export interface SearchMatch {
  verse: DocVerse;
  score: number;
  highlightedText: string;
  matchedWords: string[];
}

export function searchProjectConcordance(
  query: string,
  docFilter?: string,
  matchMode: 'any' | 'phrase' | 'all' = 'any'
): SearchMatch[] {
  const cleanQ = query.trim().toLowerCase();
  if (!cleanQ) return [];

  const terms = cleanQ.split(/\s+/).filter(Boolean);

  let pool = ALL_DOC_VERSES;
  if (docFilter && docFilter !== 'all') {
    pool = pool.filter((v) => v.docId === docFilter || v.category === docFilter);
  }

  const results: SearchMatch[] = [];

  for (const verse of pool) {
    const textLower = verse.text.toLowerCase();
    const refLower = verse.reference.toLowerCase();
    const chLower = verse.chapterTitle.toLowerCase();
    const docLower = verse.docTitle.toLowerCase();
    const tagsLower = verse.tags.map((t) => t.toLowerCase()).join(' ');

    let isMatch = false;
    let score = 0;
    const matchedTerms: string[] = [];

    if (matchMode === 'phrase') {
      if (textLower.includes(cleanQ) || chLower.includes(cleanQ) || tagsLower.includes(cleanQ)) {
        isMatch = true;
        score += 50;
        matchedTerms.push(cleanQ);
      }
    } else if (matchMode === 'all') {
      const allFound = terms.every(
        (t) =>
          textLower.includes(t) ||
          refLower.includes(t) ||
          chLower.includes(t) ||
          tagsLower.includes(t)
      );
      if (allFound) {
        isMatch = true;
        score += terms.length * 15;
        matchedTerms.push(...terms);
      }
    } else {
      // 'any' mode
      for (const t of terms) {
        if (textLower.includes(t)) {
          isMatch = true;
          score += 10;
          matchedTerms.push(t);
        } else if (tagsLower.includes(t)) {
          isMatch = true;
          score += 8;
          matchedTerms.push(t);
        } else if (chLower.includes(t) || refLower.includes(t) || docLower.includes(t)) {
          isMatch = true;
          score += 5;
          matchedTerms.push(t);
        }
      }

      // Bonus if exact phrase is matched
      if (textLower.includes(cleanQ)) {
        score += 30;
      }
    }

    if (isMatch) {
      // Create highlighted (HTML-escaped) text
      const termsToHighlight = matchMode === 'phrase' ? [cleanQ] : terms;

      results.push({
        verse,
        score,
        highlightedText: highlightTerms(verse.text, termsToHighlight.filter((t) => t.length > 1)),
        matchedWords: Array.from(new Set(matchedTerms)),
      });
    }
  }

  // Sort by highest score first
  return results.sort((a, b) => b.score - a.score);
}
