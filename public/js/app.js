/**
 * FoodCheck – app controller.
 *
 * Flow: postcode (or device location) -> coordinates -> FSA establishments
 * -> pins on a Leaflet map + a list sorted by distance. List and map stay in
 * sync: selecting in one highlights the other.
 */

import {
  AppError, lookupPostcode, reverseGeocode, fetchEstablishments, fetchBusinessTypes,
  looksLikePostcode, formatPostcode, compactPostcode,
} from './api.js';
import {
  describeRating, badgeSizeClass, formatInspectionDate, RATING_FILTERS, LEGEND,
} from './ratings.js';
import { initSettings } from './settings.js';

/* ---------- DOM ---------- */

const $ = (sel) => document.querySelector(sel);
const els = {
  form: $('#search-form'),
  input: $('#postcode'),
  inputError: $('#postcode-error'),
  locate: $('#locate-btn'),
  rating: $('#min-rating'),
  type: $('#business-type'),
  radios: document.querySelectorAll('input[name="radius"]'),
  summary: $('#summary'),
  legend: $('#legend'),
  status: $('#status'),
  list: $('#places'),
  loadMore: $('#load-more'),
  mapLoading: $('#map-loading'),
};

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- State ---------- */

const state = {
  origin: null,       // { lat, lng, label, postcode, country }
  scheme: 'fhrs',     // 'fhrs' (0–5) or 'fhis' (Scotland)
  filters: { rating: '', businessType: '', radius: 1 },
  results: [],        // normalised establishments, sorted by distance
  page: 1,
  totalPages: 1,
  total: 0,
  selectedId: null,
  controller: null,   // AbortController for the in-flight search
  lastAction: null,   // function to re-run for "Try again"
};

/* ---------- Map ---------- */

const UK_CENTRE = [54.3, -2.6];
// Leaflet's tapHold (default on iOS Safari) turns a long press into 'contextmenu'; Android does that natively.
const map = L.map('map', { zoomControl: true, scrollWheelZoom: true }).setView(UK_CENTRE, 5);
map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
}).addTo(map);

const pinLayer = L.layerGroup().addTo(map);
const markers = new Map(); // FHRSID -> L.Marker
let originMarker = null;
let radiusRing = null;

function pinIcon(info, selected = false) {
  return L.divIcon({
    className: 'pin-wrap',
    html: `<span class="pin pin--${info.tone}${selected ? ' pin--selected' : ''}"><span class="pin__label">${info.short}</span></span>`,
    iconSize: selected ? [40, 50] : [30, 38],
    iconAnchor: selected ? [20, 50] : [15, 38],
    popupAnchor: [0, selected ? -46 : -34],
  });
}

const originIcon = L.divIcon({
  className: 'origin-wrap',
  html: '<span class="origin"></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

/* ---------- Helpers ---------- */

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/** Great-circle distance in miles. */
function milesBetween(a, b) {
  const R = 3958.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const formatMiles = (mi) => (mi == null ? '' : mi < 0.1 ? 'under 0.1 mi' : `${mi.toFixed(1)} mi`);
const plural = (n, word, many = `${word}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? word : many}`;

/** Turn a raw API establishment into the shape the UI uses. */
function normalise(e) {
  const lat = parseFloat(e.geocode?.latitude);
  const lng = parseFloat(e.geocode?.longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
  const coords = hasCoords ? { lat, lng } : null;
  return {
    id: e.FHRSID != null ? String(e.FHRSID) : `${e.BusinessName}-${e.PostCode}`,
    fhrsId: e.FHRSID,
    name: e.BusinessName?.trim() || 'Unnamed business',
    type: e.BusinessType || '',
    rating: describeRating(e.RatingValue),
    date: formatInspectionDate(e.RatingDate),
    address: [e.AddressLine1, e.AddressLine2, e.AddressLine3, e.AddressLine4, e.PostCode]
      .map((s) => (s || '').trim()).filter(Boolean).join(', '),
    coords,
    distance: coords && state.origin ? milesBetween(state.origin, coords) : null,
  };
}

/* ---------- Rendering ---------- */

function setScheme(scheme) {
  const changed = scheme !== state.scheme || els.rating.options.length <= 1;
  state.scheme = scheme;
  if (changed) {
    const options = RATING_FILTERS[scheme];
    els.rating.innerHTML = options.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    // Keep the current filter if it means something in this scheme, otherwise reset it.
    if (!options.some((o) => o.value === state.filters.rating)) state.filters.rating = '';
    els.rating.value = state.filters.rating;
  }
}

/**
 * Legend for the local scheme, plus any entries from the other scheme that
 * actually appear (e.g. the odd 0–5 rated business in Glasgow).
 */
function renderLegend() {
  const present = new Set(state.results.map((r) => r.rating.tone));
  const other = state.scheme === 'fhrs' ? 'fhis' : 'fhrs';
  const items = [
    ...LEGEND[state.scheme],
    ...LEGEND[other].filter((i) => i.tone !== 'none' && present.has(i.tone)),
  ];
  els.legend.innerHTML = items
    .map((i) => `<li><span class="legend__swatch tone--${i.tone}" aria-hidden="true">${i.short}</span>${i.text}</li>`)
    .join('');
}

function badgeHtml(r) {
  const scale = r.numeric != null ? '<span class="badge__scale">out of 5</span>' : '';
  return `<div class="badge tone--${r.tone} ${badgeSizeClass(r)}" role="img" aria-label="Rating: ${escapeHtml(r.label)}${r.numeric != null ? ' out of 5' : ''}, ${escapeHtml(r.description)}">
      <span class="badge__value" aria-hidden="true">${escapeHtml(r.label)}</span>${scale}
    </div>`;
}

function placeHtml(p) {
  const meta = [p.type, formatMiles(p.distance)].filter(Boolean).map(escapeHtml).join('<span aria-hidden="true"> · </span>');
  const link = p.fhrsId
    ? `<a class="place__link" href="https://ratings.food.gov.uk/business/${encodeURIComponent(p.fhrsId)}" target="_blank" rel="noopener">Official record<span class="visually-hidden"> for ${escapeHtml(p.name)} (opens in new tab)</span><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2h6v6M10 2L3 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></a>`
    : '';
  return `<li class="place${p.coords ? '' : ' place--nomap'}" id="place-${escapeHtml(p.id)}" data-id="${escapeHtml(p.id)}">
    ${badgeHtml(p.rating)}
    <div class="place__body">
      <h3 class="place__name"><button type="button" class="place__select" data-id="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button></h3>
      <p class="place__meta">${meta}</p>
      <p class="place__verdict tone-text--${p.rating.tone}">${escapeHtml(p.rating.description)}</p>
      ${p.address ? `<p class="place__address">${escapeHtml(p.address)}</p>` : ''}
      <p class="place__foot">
        <span>${p.date ? `Inspected ${escapeHtml(p.date)}` : 'No inspection date'}</span>
        ${link}
      </p>
      ${p.coords ? '' : '<p class="place__nomap-note">No map location for this business</p>'}
    </div>
  </li>`;
}

function renderResults({ fit = true } = {}) {
  const { results } = state;

  // List
  els.list.innerHTML = results.map(placeHtml).join('');
  els.list.setAttribute('aria-busy', 'false');

  // Pins
  pinLayer.clearLayers();
  markers.clear();
  for (const p of results) {
    if (!p.coords) continue;
    const marker = L.marker([p.coords.lat, p.coords.lng], {
      icon: pinIcon(p.rating),
      title: `${p.name} – ${p.rating.label}`,
      keyboard: false, // the list is the keyboard-friendly way in
      riseOnHover: true,
    });
    marker.bindPopup(
      `<strong class="popup__name">${escapeHtml(p.name)}</strong>
       <span class="popup__rating"><span class="legend__swatch tone--${p.rating.tone}" aria-hidden="true">${escapeHtml(p.rating.short)}</span>${escapeHtml(p.rating.label)}${p.rating.numeric != null ? ' out of 5' : ''}</span>
       <span class="popup__meta">${escapeHtml(p.type)}${p.distance != null ? ` · ${formatMiles(p.distance)}` : ''}</span>`,
      { closeButton: false, autoPanPadding: [24, 24] },
    );
    marker.on('click', () => select(p.id, 'map'));
    marker.addTo(pinLayer);
    markers.set(p.id, marker);
  }

  // Summary
  const unmapped = results.filter((r) => !r.coords).length;
  const where = state.origin.label;
  const miles = state.filters.radius === 1 ? '1 mile' : `${state.filters.radius} miles`;
  let summary = state.total > results.length
    ? `Nearest ${results.length.toLocaleString('en-GB')} of ${plural(state.total, 'place')} within ${miles} of ${where}.`
    : `${plural(state.total, 'place')} within ${miles} of ${where}.`;
  if (unmapped) summary += ` ${plural(unmapped, 'place')} ${unmapped === 1 ? 'has' : 'have'} no map location.`;
  els.summary.textContent = summary;

  renderLegend();
  els.loadMore.hidden = state.page >= state.totalPages;

  if (fit) fitToResults();
  if (state.selectedId && !results.some((r) => r.id === state.selectedId)) state.selectedId = null;
}

/**
 * Leaflet silently ignores a new fitBounds while a zoom animation is running,
 * so wait for it to finish first.
 */
function fitView(bounds, { animate = !prefersReducedMotion, maxZoom = 17 } = {}) {
  const go = () => {
    map.invalidateSize();
    map.fitBounds(bounds, { padding: [28, 28], maxZoom, animate });
  };
  if (map._animatingZoom) map.once('zoomend', go);
  else go();
}

/** While loading: jump straight to the search circle. */
function fitToSearchArea() {
  if (radiusRing) fitView(radiusRing.getBounds(), { animate: false });
}

/** With results: frame the origin and every mapped pin (the nearest 100 are often much closer than the radius). */
function fitToResults() {
  const points = state.results.filter((r) => r.coords).map((r) => [r.coords.lat, r.coords.lng]);
  if (!points.length) return fitToSearchArea();
  fitView(L.latLngBounds([[state.origin.lat, state.origin.lng], ...points]));
}

/** On phones, bring the sticky map + list into view after a new search. */
function revealResultsOnMobile() {
  if (!window.matchMedia('(max-width: 959px)').matches) return;
  const mapPane = document.querySelector('.map-pane');
  const listTop = document.querySelector('.list-pane').getBoundingClientRect().top + window.scrollY;
  window.scrollTo({ top: listTop - mapPane.offsetHeight, behavior: prefersReducedMotion ? 'auto' : 'smooth' });
}

function showOrigin() {
  const { lat, lng } = state.origin;
  const metres = state.filters.radius * 1609.34;
  if (!originMarker) {
    originMarker = L.marker([lat, lng], { icon: originIcon, keyboard: false, interactive: false, zIndexOffset: -1000 }).addTo(map);
    radiusRing = L.circle([lat, lng], {
      radius: metres, interactive: false,
      className: 'radius-ring', weight: 1.5, dashArray: '4 6', fillOpacity: 0.04,
    }).addTo(map);
  } else {
    originMarker.setLatLng([lat, lng]);
    radiusRing.setLatLng([lat, lng]).setRadius(metres);
  }
}

/** Status panel: one of intro / loading / error / empty / nothing. */
function setStatus(kind, opts = {}) {
  els.mapLoading.hidden = kind !== 'loading';
  els.status.className = `status status--${kind}`;

  if (kind === 'loading') {
    els.status.innerHTML = `<span class="visually-hidden">${escapeHtml(opts.message || 'Loading results…')}</span>`;
    els.summary.textContent = opts.message || 'Loading…';
    els.list.setAttribute('aria-busy', 'true');
    els.list.innerHTML = Array.from({ length: 4 }, () => `
      <li class="place place--skeleton" aria-hidden="true">
        <div class="badge skeleton"></div>
        <div class="place__body"><span class="skeleton skeleton--line w60"></span><span class="skeleton skeleton--line w40"></span><span class="skeleton skeleton--line w80"></span></div>
      </li>`).join('');
    els.loadMore.hidden = true;
    return;
  }

  if (kind === 'intro') {
    els.summary.textContent = '';
    els.list.innerHTML = '';
    els.status.innerHTML = `
      <h3 class="status__title">Check before you eat</h3>
      <p>Enter a postcode, or press and hold anywhere on the map, to see how nearby restaurants, takeaways, cafés and shops did at their last food hygiene inspection.</p>
      <p class="status__try">Try
        <button type="button" class="chip" data-postcode="G3 7TF">G3 7TF</button>
        <button type="button" class="chip" data-postcode="SW1A 1AA">SW1A 1AA</button>
        <button type="button" class="chip" data-postcode="EH1 1YZ">EH1 1YZ</button>
      </p>`;
    renderLegend();
    return;
  }

  if (kind === 'error') {
    els.summary.textContent = '';
    els.list.innerHTML = '';
    els.loadMore.hidden = true;
    els.status.innerHTML = `
      <div role="alert">
        <h3 class="status__title">${escapeHtml(opts.title || 'Something went wrong')}</h3>
        <p>${escapeHtml(opts.message || 'Please try again.')}</p>
        ${opts.retry ? '<button type="button" class="btn btn--outline" data-action="retry">Try again</button>' : ''}
      </div>`;
    return;
  }

  if (kind === 'empty') {
    const filtered = state.filters.rating || state.filters.businessType;
    const wider = [1, 2, 5].find((r) => r > state.filters.radius);
    els.list.innerHTML = '';
    els.loadMore.hidden = true;
    els.status.innerHTML = `
      <h3 class="status__title">No places found</h3>
      <p>Nothing within ${state.filters.radius === 1 ? '1 mile' : `${state.filters.radius} miles`} of ${escapeHtml(state.origin.label)}${filtered ? ' matches your filters' : ''}.</p>
      <p class="status__actions">
        ${wider ? `<button type="button" class="btn btn--outline" data-action="widen" data-radius="${wider}">Search within ${wider} miles</button>` : ''}
        ${filtered ? '<button type="button" class="btn btn--quiet" data-action="clear-filters">Clear filters</button>' : ''}
      </p>`;
    return;
  }

  els.status.innerHTML = '';
}

/* ---------- Selection (list <-> map) ---------- */

function select(id, source) {
  const prev = state.selectedId;
  if (prev && prev !== id) {
    const prevPlace = state.results.find((r) => r.id === prev);
    if (prevPlace) markers.get(prev)?.setIcon(pinIcon(prevPlace.rating)).setZIndexOffset(0);
    document.getElementById(`place-${prev}`)?.classList.remove('is-selected');
  }
  state.selectedId = id;

  const place = state.results.find((r) => r.id === id);
  const item = document.getElementById(`place-${id}`);
  const marker = markers.get(id);
  if (!place) return;

  item?.classList.add('is-selected');
  if (marker) {
    marker.setIcon(pinIcon(place.rating, true)).setZIndexOffset(1000);
    if (source === 'list') {
      const zoom = Math.max(map.getZoom(), 16);
      if (prefersReducedMotion) map.setView(marker.getLatLng(), zoom);
      else map.flyTo(marker.getLatLng(), zoom, { duration: 0.6 });
      map.once('moveend', () => marker.openPopup());
    }
  }

  if (source === 'map' && item) {
    item.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'nearest' });
  }
}

/* ---------- Search ---------- */

function readFiltersFromUi() {
  state.filters.rating = els.rating.value;
  state.filters.businessType = els.type.value;
  state.filters.radius = Number([...els.radios].find((r) => r.checked)?.value || 1);
}

function syncUrl() {
  const params = new URLSearchParams();
  const { origin } = state;
  if (origin?.source === 'postcode') params.set('pc', compactPostcode(origin.postcode));
  else if (origin) {
    // Device locations go in the URL rounded to ~100 m, so a shared link doesn't reveal an exact position.
    // Points picked on the map aren't private, so keep them to ~10 m.
    const dp = origin.source === 'device' ? 3 : 4;
    params.set('lat', origin.lat.toFixed(dp));
    params.set('lng', origin.lng.toFixed(dp));
  }
  if (state.filters.radius !== 1) params.set('r', state.filters.radius);
  if (state.filters.rating) params.set('rating', state.filters.rating);
  if (state.filters.businessType) params.set('type', state.filters.businessType);
  const qs = params.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
}

function startRequest() {
  state.controller?.abort();
  state.controller = new AbortController();
  return state.controller.signal;
}

function handleError(err, retry) {
  if (err.name === 'AbortError') return;
  console.error(err);
  state.lastAction = retry;
  const titles = {
    'invalid-postcode': 'Postcode not found',
    network: 'Can’t connect',
    api: 'Service unavailable',
    location: 'Location unavailable',
  };
  setStatus('error', {
    title: titles[err.kind] || 'Something went wrong',
    message: err instanceof AppError ? err.message : 'An unexpected error occurred. Please try again.',
    retry: err.kind === 'network' || err.kind === 'api' || !(err instanceof AppError),
  });
}

/** Fetch page 1 for the current origin + filters. */
async function loadEstablishments() {
  const signal = startRequest();
  state.selectedId = null;
  showOrigin();
  fitToSearchArea();
  syncUrl();
  setStatus('loading', { message: `Finding places near ${state.origin.label}…` });
  try {
    const data = await fetchEstablishments({ ...state.origin, ...state.filters, page: 1 }, { signal });
    state.page = data.page;
    state.totalPages = data.totalPages;
    state.total = data.total;
    state.results = sortByDistance(data.establishments.map(normalise));
    // No country from the postcode lookup (e.g. raw device location): infer the scheme from the results.
    if (!state.origin.country && state.results.length) {
      const scottish = state.results.filter((r) => ['pass', 'fail'].includes(r.rating.tone)).length;
      const numeric = state.results.filter((r) => r.rating.numeric != null).length;
      setScheme(scottish > numeric ? 'fhis' : 'fhrs');
    }
    if (!state.results.length) {
      pinLayer.clearLayers();
      markers.clear();
      els.summary.textContent = '';
      renderLegend();
      setStatus('empty');
      return;
    }
    setStatus('none');
    renderResults();
  } catch (err) {
    handleError(err, loadEstablishments);
  } finally {
    els.mapLoading.hidden = true;
  }
}

/** Items without coordinates keep the API's order but go after mapped ones at the same rank. */
function sortByDistance(list) {
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.distance ?? Infinity) - (b.p.distance ?? Infinity) || a.i - b.i)
    .map(({ p }) => p);
}

async function loadMore() {
  const signal = startRequest();
  els.loadMore.disabled = true;
  els.loadMore.textContent = 'Loading…';
  try {
    const data = await fetchEstablishments({ ...state.origin, ...state.filters, page: state.page + 1 }, { signal });
    state.page = data.page;
    state.totalPages = data.totalPages;
    const seen = new Set(state.results.map((r) => r.id));
    const extra = data.establishments.map(normalise).filter((p) => !seen.has(p.id));
    state.results = sortByDistance([...state.results, ...extra]);
    renderResults({ fit: false });
    if (state.selectedId) select(state.selectedId);
  } catch (err) {
    if (err.name !== 'AbortError') {
      els.summary.textContent = err.message || 'Couldn’t load more places. Please try again.';
    }
  } finally {
    els.loadMore.disabled = false;
    els.loadMore.textContent = 'Show more places';
  }
}

async function searchPostcode(raw) {
  const value = String(raw || '').trim();
  showInputError('');
  if (!value) {
    showInputError('Enter a postcode, like SW1A 1AA.');
    els.input.focus();
    return;
  }
  if (!looksLikePostcode(value)) {
    showInputError('That doesn’t look like a UK postcode. Try something like G3 7TF.');
    els.input.focus();
    return;
  }

  els.input.value = formatPostcode(value);
  els.input.blur(); // dismiss the on-screen keyboard on phones
  const signal = startRequest();
  setStatus('loading', { message: `Looking up ${formatPostcode(value)}…` });
  try {
    const place = await lookupPostcode(value, { signal });
    state.origin = { ...place, source: 'postcode', label: place.postcode };
    setScheme(place.country === 'Scotland' ? 'fhis' : 'fhrs');
    revealResultsOnMobile();
    await loadEstablishments();
  } catch (err) {
    if (err.kind === 'invalid-postcode') {
      showInputError(err.message);
      setStatus(state.results.length ? 'none' : 'intro');
      if (state.results.length) renderResults({ fit: false });
      els.mapLoading.hidden = true;
      return;
    }
    handleError(err, () => searchPostcode(value));
  }
}

function showInputError(message) {
  els.inputError.textContent = message;
  els.inputError.hidden = !message;
  els.input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

/**
 * Search around a coordinate.
 * @param {'device'|'map'} source  where the point came from (affects wording and URL precision)
 */
async function searchByCoords(lat, lng, source = 'device') {
  const signal = startRequest();
  showInputError('');
  setStatus('loading', { message: 'Finding the nearest postcode…' });
  try {
    const near = await reverseGeocode(lat, lng, { signal });
    const what = source === 'map' ? 'the point you picked' : 'your location';
    state.origin = {
      lat, lng,
      source,
      postcode: near?.postcode || null,
      country: near?.country || null,
      label: near ? `${what} (near ${near.postcode})` : what,
    };
    els.input.value = near ? near.postcode : '';
    setScheme(near?.country === 'Scotland' ? 'fhis' : 'fhrs');
    if (source === 'device') revealResultsOnMobile(); // a map pick: the map is already on screen
    await loadEstablishments();
  } catch (err) {
    handleError(err, () => searchByCoords(lat, lng, source));
  }
}

const inUk = (lat, lng) => lat >= 49.5 && lat <= 61 && lng >= -8.8 && lng <= 2.1;

/* ---------- Press and hold (or right-click) the map to search there ---------- */

let lastPick = 0;
map.on('contextmenu', (e) => {
  // Some Android browsers fire both a native and Leaflet's emulated event for one press.
  if (Date.now() - lastPick < 800) return;
  lastPick = Date.now();

  const { lat, lng } = e.latlng;
  if (!inUk(lat, lng)) {
    handleError(new AppError('location', 'FoodCheck only covers the UK. Press and hold somewhere in the UK instead.'));
    return;
  }
  navigator.vibrate?.(12); // a small tap of feedback where supported (Android)
  dismissMapHint();
  searchByCoords(lat, lng, 'map');
});

/** One-off hint telling people they can press and hold the map. */
const HINT_KEY = 'foodcheck:mapHintSeen';
let mapHint = null;

function showMapHint() {
  try { if (localStorage.getItem(HINT_KEY)) return; } catch { /* storage blocked: still show it */ }
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const Hint = L.Control.extend({
    options: { position: 'bottomleft' },
    onAdd() {
      const el = L.DomUtil.create('div', 'map-hint');
      el.setAttribute('role', 'note');
      el.textContent = touch ? 'Press and hold the map to search there' : 'Right-click the map to search there';
      L.DomEvent.disableClickPropagation(el);
      return el;
    },
  });
  mapHint = new Hint().addTo(map);
}

function dismissMapHint() {
  if (!mapHint) return;
  mapHint.remove();
  mapHint = null;
  try { localStorage.setItem(HINT_KEY, '1'); } catch { /* ignore */ }
}

function useMyLocation() {
  showInputError('');
  if (!('geolocation' in navigator) || !window.isSecureContext) {
    handleError(new AppError('location', 'Your browser can’t share your location here. Enter a postcode instead.'));
    return;
  }
  els.locate.disabled = true;
  els.locate.classList.add('is-busy');
  setStatus('loading', { message: 'Finding your location…' });
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      els.locate.disabled = false;
      els.locate.classList.remove('is-busy');
      // Round to 4 dp (~10 m) before the position is sent to postcodes.io / the FSA: plenty for a 1-mile search.
      const round = (n) => Math.round(n * 1e4) / 1e4;
      searchByCoords(round(pos.coords.latitude), round(pos.coords.longitude));
    },
    (err) => {
      els.locate.disabled = false;
      els.locate.classList.remove('is-busy');
      els.mapLoading.hidden = true;
      const message = err.code === err.PERMISSION_DENIED
        ? 'Location access is turned off for this site. Allow it in your browser settings, or enter a postcode instead.'
        : 'We couldn’t work out where you are. Enter a postcode instead.';
      handleError(new AppError('location', message), useMyLocation);
    },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60 * 1000 },
  );
}

/* ---------- Events ---------- */

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  searchPostcode(els.input.value);
});

els.input.addEventListener('input', () => {
  if (!els.inputError.hidden) showInputError('');
});

els.locate.addEventListener('click', useMyLocation);

for (const control of [els.rating, els.type, ...els.radios]) {
  control.addEventListener('change', () => {
    readFiltersFromUi();
    if (state.origin) loadEstablishments();
  });
}

els.loadMore.addEventListener('click', loadMore);

// Clicking anywhere on a card (except its link) selects it; the name button covers keyboard users.
els.list.addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const item = e.target.closest('.place[data-id]');
  if (item && !item.classList.contains('place--skeleton')) select(item.dataset.id, 'list');
});

els.status.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.postcode) {
    els.input.value = btn.dataset.postcode;
    searchPostcode(btn.dataset.postcode);
  } else if (btn.dataset.action === 'retry') {
    state.lastAction?.();
  } else if (btn.dataset.action === 'widen') {
    document.getElementById(`r${btn.dataset.radius}`).checked = true;
    readFiltersFromUi();
    loadEstablishments();
  } else if (btn.dataset.action === 'clear-filters') {
    els.rating.value = '';
    els.type.value = '';
    readFiltersFromUi();
    loadEstablishments();
  }
});

// Keep Leaflet's size correct when the layout changes (rotation, desktop resize).
window.addEventListener('resize', () => map.invalidateSize());

/* ---------- Start-up ---------- */

async function loadBusinessTypes() {
  try {
    const types = await fetchBusinessTypes();
    els.type.insertAdjacentHTML('beforeend',
      types.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)}</option>`).join(''));
    els.type.value = state.filters.businessType;
  } catch {
    // The filter is optional; leave "All types" in place if the list can't load.
    els.type.title = 'Business types couldn’t be loaded';
  }
}

function restoreFromUrl() {
  const params = new URLSearchParams(location.search);
  const radius = Number(params.get('r'));
  if ([1, 2, 5].includes(radius)) {
    state.filters.radius = radius;
    document.getElementById(`r${radius}`).checked = true;
  }
  // Only accept values the UI could have produced; ignore anything else.
  const rating = params.get('rating') || '';
  const knownRatings = [...RATING_FILTERS.fhrs, ...RATING_FILTERS.fhis].map((o) => o.value);
  state.filters.rating = knownRatings.includes(rating) ? rating : '';
  const type = params.get('type') || '';
  state.filters.businessType = /^\d{1,6}$/.test(type) ? type : '';
  return params;
}

async function init() {
  initSettings();
  showMapHint();
  const params = restoreFromUrl();
  // Scottish filter values are words ("Pass"), FHRS ones are digits.
  setScheme(/^[a-z]/i.test(state.filters.rating) ? 'fhis' : 'fhrs');
  const types = loadBusinessTypes();

  const lat = parseFloat(params.get('lat'));
  const lng = parseFloat(params.get('lng'));
  if (params.get('pc')) {
    els.input.value = formatPostcode(params.get('pc'));
    await types; // so a restored business-type filter is selectable
    searchPostcode(params.get('pc'));
  } else if (inUk(lat, lng)) {
    await types;
    searchByCoords(lat, lng, 'map'); // a shared link: treat it as a picked point, not the viewer's location
  } else {
    setStatus('intro');
  }
}

init();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  });
}
