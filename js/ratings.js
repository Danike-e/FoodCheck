/**
 * Rating helpers.
 *
 * The FSA API returns two schemes:
 *  - FHRS (England, Wales, Northern Ireland): "0"–"5", plus "AwaitingInspection",
 *    "AwaitingPublication" and "Exempt".
 *  - FHIS (Scotland): "Pass", "Improvement Required", "Awaiting Inspection",
 *    "Awaiting Publication" and "Exempt".
 *
 * Everything the UI needs to show a rating (colour tone, short pin label, long
 * description) is derived here, so the rest of the app never parses raw values.
 */

const DESCRIPTIONS = {
  5: 'Very good',
  4: 'Good',
  3: 'Generally satisfactory',
  2: 'Improvement necessary',
  1: 'Major improvement necessary',
  0: 'Urgent improvement necessary',
};

/** Lower-case and strip spaces so "Awaiting Inspection" == "AwaitingInspection". */
const normalise = (value) => String(value ?? '').toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Describe a raw RatingValue.
 * @returns {{tone: string, short: string, label: string, description: string, numeric: number|null}}
 *   tone        – CSS modifier: r5, r4, r3, r2, r1 (0–1), pass, fail, none
 *   short       – text shown inside the map pin / badge
 *   label       – main badge text (e.g. "5" or "Pass")
 *   description – plain-English meaning
 */
export function describeRating(raw) {
  const value = normalise(raw);

  if (/^[0-5]$/.test(value)) {
    const n = Number(value);
    return {
      tone: n <= 1 ? 'r1' : `r${n}`,
      short: value,
      label: value,
      description: DESCRIPTIONS[n],
      numeric: n,
    };
  }

  switch (value) {
    case 'pass':
      return { tone: 'pass', short: '✓', label: 'Pass', description: 'Meets legal requirements', numeric: null };
    case 'passandeatsafe':
      return { tone: 'pass', short: '✓', label: 'Pass', description: 'Pass and Eat Safe', numeric: null };
    case 'improvementrequired':
      return { tone: 'fail', short: '!', label: 'Improvement required', description: 'Does not yet meet legal requirements', numeric: null };
    case 'exempt':
      return { tone: 'none', short: 'E', label: 'Exempt', description: 'Low-risk business, not rated', numeric: null };
    case 'awaitingpublication':
      return { tone: 'none', short: '…', label: 'Awaiting publication', description: 'Inspected, rating not yet published', numeric: null };
    case 'awaitinginspection':
    default:
      return { tone: 'none', short: '–', label: 'Awaiting inspection', description: 'Not yet inspected', numeric: null };
  }
}

/** Badge class for a rating: words and phrases get progressively smaller type. */
export function badgeSizeClass(info) {
  if (info.label.length <= 1) return '';
  return info.label.length <= 6 ? 'badge--word' : 'badge--text';
}

/** Rating-filter options for each scheme. Values map straight onto the API's ratingKey. */
export const RATING_FILTERS = {
  fhrs: [
    { value: '', label: 'Any rating' },
    { value: '5', label: '5 only' },
    { value: '4', label: '4 or better' },
    { value: '3', label: '3 or better' },
    { value: '2', label: '2 or better' },
    { value: '1', label: '1 or better' },
  ],
  fhis: [
    { value: '', label: 'Any result' },
    { value: 'Pass', label: 'Pass only' },
    { value: 'ImprovementRequired', label: 'Improvement required' },
  ],
};

/** Legend entries per scheme, in display order. */
export const LEGEND = {
  fhrs: [
    { tone: 'r5', short: '5', text: 'Very good' },
    { tone: 'r4', short: '4', text: 'Good' },
    { tone: 'r3', short: '3', text: 'Satisfactory' },
    { tone: 'r2', short: '2', text: 'Needs improving' },
    { tone: 'r1', short: '0–1', text: 'Poor' },
    { tone: 'none', short: '–', text: 'Not rated' },
  ],
  fhis: [
    { tone: 'pass', short: '✓', text: 'Pass' },
    { tone: 'fail', short: '!', text: 'Improvement required' },
    { tone: 'none', short: '–', text: 'Not rated' },
  ],
};

/** The FSA uses 0001-01-01 / 1901-01-01 to mean "no date". */
export function formatInspectionDate(raw) {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime()) || date.getFullYear() < 1950) return null;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
