'use strict';
// indexability/schema.js — structured data, one level deeper than "is there any and does it parse".
//
// WHAT ALREADY SHIPPED. SEO-016..019 answer four questions: is there JSON-LD, does it parse, does each
// item declare `@type`, is `@context` schema.org. Those are real and they stay. They are also the
// entire structured-data surface, which means a page can carry a `Product` with no name and no offer,
// or an `Article` with no headline, and score a clean pass on all four. Valid JSON that declares a type
// Google cannot use is the most common structured-data defect there is, and the tool could not see it.
//
// WHAT THIS ADDS. Per-`@type` REQUIRED-property validation for the types that actually gate rich
// results, plus a site-wide inventory of which types are present. Two tiers, kept apart on purpose:
//
//   • REQUIRED — the item is ineligible without it. Google's own documentation, not opinion. This is
//     the scored tier (SEO-049), and the list is deliberately SHORT: only properties whose absence is
//     documented as disqualifying. A "required" list padded with nice-to-haves would fail correct
//     markup, and a structured-data checker that cries wolf gets switched off.
//   • RECOMMENDED — improves eligibility or presentation, absence is legal. Advisory, never scored.
//
// @graph AND @id ARE HANDLED, because not handling them is how these checkers produce their worst
// false positives. Real-world markup (Yoast, RankMath, most CMS plugins) emits a `@graph` of nodes that
// reference each other by `@id` — the Article's `author` is `{"@id": "…#/schema/person/1"}`, not an
// inline Person. A validator that only reads inline values calls that a missing author on a site whose
// markup is exactly right. So nodes are collected graph-wide first, and an `@id` reference counts as
// satisfying a property when the referenced node exists in the same document.

// [required[], recommended[]] per @type. Short lists, sourced from the rich-result requirements.
const TYPE_RULES = {
  Article: [['headline'], ['image', 'datePublished', 'dateModified', 'author']],
  NewsArticle: [['headline'], ['image', 'datePublished', 'dateModified', 'author']],
  BlogPosting: [['headline'], ['image', 'datePublished', 'dateModified', 'author']],
  Product: [['name'], ['image', 'description', 'brand', 'sku', 'aggregateRating', 'review']],
  Offer: [['price', 'priceCurrency'], ['availability', 'priceValidUntil', 'url']],
  Organization: [['name'], ['url', 'logo', 'sameAs', 'contactPoint']],
  LocalBusiness: [['name', 'address'], ['telephone', 'openingHours', 'geo', 'priceRange', 'image', 'url']],
  BreadcrumbList: [['itemListElement'], []],
  ListItem: [['position', 'name'], ['item']],
  FAQPage: [['mainEntity'], []],
  Question: [['name', 'acceptedAnswer'], []],
  Answer: [['text'], []],
  Event: [['name', 'startDate', 'location'], ['endDate', 'image', 'description', 'offers', 'performer']],
  Recipe: [['name', 'image', 'recipeIngredient', 'recipeInstructions'], ['author', 'datePublished', 'description', 'prepTime', 'cookTime', 'nutrition']],
  Review: [['itemReviewed', 'reviewRating'], ['author', 'datePublished']],
  AggregateRating: [['ratingValue'], ['reviewCount', 'ratingCount', 'bestRating']],
  VideoObject: [['name', 'description', 'thumbnailUrl', 'uploadDate'], ['duration', 'contentUrl', 'embedUrl']],
  JobPosting: [['title', 'description', 'datePosted', 'hiringOrganization', 'jobLocation'], ['baseSalary', 'employmentType', 'validThrough']],
  Person: [['name'], ['url', 'sameAs', 'jobTitle', 'image']],
  WebSite: [['name', 'url'], ['potentialAction', 'publisher']],
  WebPage: [['name'], ['description', 'url', 'isPartOf']],
  SoftwareApplication: [['name'], ['offers', 'aggregateRating', 'applicationCategory', 'operatingSystem']],
  Service: [['name'], ['provider', 'areaServed', 'description']],
  PostalAddress: [['addressLocality'], ['streetAddress', 'addressRegion', 'postalCode', 'addressCountry']],
};

// Types that inherit LocalBusiness's requirements. schema.org's hierarchy is large; this covers the
// subtypes a business site actually uses. An unknown type is NOT an error — it is simply not validated,
// which is stated in the output rather than being silently treated as a pass.
const LOCAL_BUSINESS_SUBTYPES = new Set([
  'Restaurant', 'Store', 'Dentist', 'Physician', 'LegalService', 'Attorney', 'RealEstateAgent',
  'HomeAndConstructionBusiness', 'ProfessionalService', 'MedicalBusiness', 'HealthAndBeautyBusiness',
  'AutomotiveBusiness', 'FinancialService', 'InsuranceAgency', 'Plumber', 'Electrician', 'RoofingContractor',
  'GeneralContractor', 'HVACBusiness', 'MovingCompany', 'ChildCare', 'DaySpa', 'BeautySalon', 'HairSalon',
  'Hotel', 'LodgingBusiness', 'TravelAgency', 'Bakery', 'CafeOrCoffeeShop', 'BarOrPub', 'FoodEstablishment',
]);

const ORG_SUBTYPES = new Set(['Corporation', 'NGO', 'EducationalOrganization', 'GovernmentOrganization', 'SportsOrganization', 'MedicalOrganization', 'NewsMediaOrganization', 'OnlineBusiness']);

function rulesFor(type) {
  if (TYPE_RULES[type]) return TYPE_RULES[type];
  if (LOCAL_BUSINESS_SUBTYPES.has(type)) return TYPE_RULES.LocalBusiness;
  if (ORG_SUBTYPES.has(type)) return TYPE_RULES.Organization;
  return null;
}

// ---- extraction -------------------------------------------------------------------------------

function jsonLdBlocks(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    out.push(m[1]);
  }
  return out;
}

const typesOf = (node) => {
  const t = node && node['@type'];
  if (!t) return [];
  return (Array.isArray(t) ? t : [t]).map(x => String(x).replace(/^https?:\/\/schema\.org\//i, '')).filter(Boolean);
};

// Walk every node in a parsed JSON-LD document — top-level arrays, `@graph`, and nested objects — so a
// Product inside a WebPage inside a @graph is validated the same as one at the root.
function collectNodes(parsed, acc = [], depth = 0) {
  if (depth > 12 || parsed == null) return acc;
  if (Array.isArray(parsed)) { for (const x of parsed) collectNodes(x, acc, depth + 1); return acc; }
  if (typeof parsed !== 'object') return acc;
  if (parsed['@type']) acc.push(parsed);
  for (const [k, v] of Object.entries(parsed)) {
    if (k === '@context') continue;
    if (v && typeof v === 'object') collectNodes(v, acc, depth + 1);
  }
  return acc;
}

// A property counts as PRESENT when it holds a non-empty value, OR when it is an `@id` reference to a
// node that exists in this document. See the header — this is the false-positive guard that makes the
// check usable against CMS-generated @graph markup.
function hasProp(node, prop, idIndex) {
  if (!(prop in node)) return false;
  const v = node[prop];
  if (v == null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0 && v.some(x => hasProp({ x }, 'x', idIndex));
  if (typeof v === 'object') {
    if (v['@id'] && !Object.keys(v).some(k => k !== '@id')) return idIndex.has(v['@id']); // pure reference
    return Object.keys(v).length > 0;
  }
  return true; // number / boolean
}

// ---------------------------------------------------------------------------------------------
// Validate every page's JSON-LD. Returns per-page items plus a site-wide type inventory.
function scanSchema(pages = []) {
  const missingRequired = [];     // scored (SEO-049)
  const missingRecommended = [];  // advisory
  const unvalidatedTypes = new Map();
  const typeCounts = new Map();
  const parseErrors = [];
  let pagesWithSchema = 0;

  for (const page of pages.filter(Boolean)) {
    const url = page.url || '';
    const blocks = jsonLdBlocks(page.html || page.body || '');
    if (!blocks.length) continue;
    let sawAny = false;

    for (const raw of blocks) {
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) {
        // SEO-017 already owns "invalid JSON-LD". Recorded here only so the counts in this module's
        // own summary are not silently short — it does not emit a second finding for the same fact.
        parseErrors.push({ page: url, error: String(e.message).slice(0, 120) });
        continue;
      }
      const nodes = collectNodes(parsed);
      if (!nodes.length) continue;
      sawAny = true;
      const idIndex = new Set(nodes.map(n => n['@id']).filter(Boolean));

      for (const node of nodes) {
        for (const type of typesOf(node)) {
          typeCounts.set(type, (typeCounts.get(type) || 0) + 1);
          const rules = rulesFor(type);
          if (!rules) { unvalidatedTypes.set(type, (unvalidatedTypes.get(type) || 0) + 1); continue; }
          const [required, recommended] = rules;
          const missReq = required.filter(p => !hasProp(node, p, idIndex));
          const missRec = recommended.filter(p => !hasProp(node, p, idIndex));
          if (missReq.length) missingRequired.push({ page: url, section: type, id: `${type}: missing ${missReq.join(', ')}`, value: missReq.join(', ') });
          if (missRec.length) missingRecommended.push({ page: url, section: type, id: `${type}: no ${missRec.join(', ')}`, value: missRec.join(', ') });
        }
      }
    }
    if (sawAny) pagesWithSchema++;
  }

  const dedupe = (arr) => {
    const seen = new Set(); const out = [];
    for (const it of arr) { const k = it.page + '|' + it.id; if (!seen.has(k)) { seen.add(k); out.push(it); } }
    return out.sort((a, b) => (a.page + a.id).localeCompare(b.page + b.id));
  };

  return {
    pagesWithSchema,
    types: [...typeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([type, count]) => ({ type, count })),
    // Named so an operator can tell "we checked it and it is fine" from "this tool has no rules for
    // that type" — the distinction the rest of this engine spends its comments defending.
    unvalidatedTypes: [...unvalidatedTypes.entries()].sort().map(([type, count]) => ({ type, count })),
    missingRequired: dedupe(missingRequired),
    missingRecommended: dedupe(missingRecommended),
    parseErrors,
  };
}

module.exports = { scanSchema, jsonLdBlocks, collectNodes, typesOf, rulesFor, TYPE_RULES, LOCAL_BUSINESS_SUBTYPES };
