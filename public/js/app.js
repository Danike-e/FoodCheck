/**
 * FoodCheck – app controller.
 *
 * Flow: postcode (or device location) -> coordinates -> FSA establishments
 * -> pins on a Leaflet map + a list sorted by distance. List and map stay in
 * sync: selecting in one highlights the other.
 */

import {
  AppError, lookupPostcode, reverseGeocode, fetchEstablishments, fetchBusinessTypes,
  looksLikePostcode, formatPostcode, compactPostcode, PAGE_SIZE,
} from './api.js';
import {
  describeRating, badgeSizeClass, formatInspectionDate, RATING_FILTERS, LEGEND,
} from './ratings.js';
import { initSettings } from './settings.js';
import { pageWindow } from './pager.js';
import { addToHistory, getHistory, historyUrl, describeEntry } from './history.js';

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
  pager: $('#pager'),
  heading: $('#results-heading'),
  recent: $('#recent'),
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
  initialPage: 1,     // page from a shared URL, used once by the first search
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

/* ---------- Full-screen map ----------
 * The map pane expands to cover the whole window. This is done with CSS rather
 * than the Fullscreen API, which iPhone Safari only supports for video, so it
 * behaves the same everywhere (including the installed app). While expanded,
 * the rest of the page is made inert so keyboard and screen-reader users stay
 * in the map; Escape or the button returns to the normal layout.
 */
const ICON_EXPAND = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 8V3.5H8M12 3.5h4.5V8M16.5 12v4.5H12M8 16.5H3.5V12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_COLLAPSE = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 3.5V8H3.5M16.5 8H12V3.5M12 16.5V12h4.5M3.5 12H8v4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
let fullscreenBtn = null;

const FullscreenControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const wrap = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
    fullscreenBtn = L.DomUtil.create('button', 'map-fs-btn', wrap);
    fullscreenBtn.type = 'button';
    L.DomEvent.disableClickPropagation(wrap);
    fullscreenBtn.addEventListener('click', () => setMapFullscreen(!isMapFullscreen()));
    updateFullscreenButton(false);
    return wrap;
  },
});
new FullscreenControl().addTo(map);

const isMapFullscreen = () => document.documentElement.classList.contains('map-fullscreen');

function updateFullscreenButton(on) {
  const label = on ? 'Exit full screen map' : 'Show map full screen';
  fullscreenBtn.innerHTML = on ? ICON_COLLAPSE : ICON_EXPAND;
  fullscreenBtn.setAttribute('aria-label', label);
  fullscreenBtn.setAttribute('aria-pressed', String(on));
  fullscreenBtn.title = label;
}

function setMapFullscreen(on) {
  const center = map.getCenter();
  const zoom = map.getZoom();
  document.documentElement.classList.toggle('map-fullscreen', on);
  document.querySelector('.map-pane').classList.toggle('is-fullscreen', on);
  for (const el of document.querySelectorAll('.skip-link, .masthead, .search, .list-pane')) el.inert = on;
  updateFullscreenButton(on);
  // Leaflet must re-measure after the container changes size; keep the same view.
  map.invalidateSize({ animate: false });
  map.setView(center, zoom, { animate: false });
  fullscreenBtn.focus({ preventScroll: true });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isMapFullscreen() && !document.querySelector('dialog[open]')) {
    // Let Escape close an open popup first; a second press leaves full screen.
    if (document.querySelector('.leaflet-popup')) map.closePopup();
    else setMapFullscreen(false);
  }
});

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
  const first = (state.page - 1) * PAGE_SIZE + 1;
  const last = first + results.length - 1;
  let summary = state.totalPages > 1
    ? `Places ${first.toLocaleString('en-GB')}–${last.toLocaleString('en-GB')} of ${state.total.toLocaleString('en-GB')} within ${miles} of ${where}, nearest first.`
    : `${plural(state.total, 'place')} within ${miles} of ${where}.`;
  if (unmapped) summary += ` ${plural(unmapped, 'place')} ${unmapped === 1 ? 'has' : 'have'} no map location.`;
  els.summary.textContent = summary;

  renderLegend();
  renderPager();

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
    els.pager.hidden = true;
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
      </p>
      <p><a class="status__more" href="about.html">New to FoodCheck? See how it works</a></p>`;
    renderLegend();
    return;
  }

  if (kind === 'error') {
    els.summary.textContent = '';
    els.list.innerHTML = '';
    els.pager.hidden = true;
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
    els.pager.hidden = true;
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

  if (source === 'map' && item && !isMapFullscreen()) {
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
  if (state.page > 1) params.set('p', state.page);
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

/**
 * Fetch one page of results for the current origin + filters.
 * @param {number} page
 * @param {{ fromPager?: boolean }} [opts]  true when the user changed page (moves focus to the results)
 */
async function loadEstablishments(page = 1, { fromPager = false } = {}) {
  const signal = startRequest();
  state.selectedId = null;
  state.page = page;
  showOrigin();
  if (!fromPager) fitToSearchArea();
  syncUrl();
  setStatus('loading', { message: page > 1 ? `Loading page ${page}…` : `Finding places near ${state.origin.label}…` });
  if (fromPager) showResultsTop();
  try {
    const data = await fetchEstablishments({ ...state.origin, ...state.filters, page }, { signal });
    // A shared link can point past the last page (data changes): go to the last real page instead.
    if (!data.establishments.length && page > 1 && data.totalPages >= 1 && data.total > 0) {
      return loadEstablishments(Math.min(page - 1, data.totalPages), { fromPager });
    }
    state.page = page;
    state.totalPages = Math.max(1, data.totalPages);
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
      if (!fromPager) recordSearch();
      return;
    }
    setStatus('none');
    renderResults();
    syncUrl();
    if (!fromPager) recordSearch();
    if (fromPager) els.heading.focus({ preventScroll: true }); // screen readers start at the new page
  } catch (err) {
    handleError(err, () => loadEstablishments(page, { fromPager }));
  } finally {
    els.mapLoading.hidden = true;
  }
}

/** Save the current search to history (only kept on this device) and refresh the Recent row. */
function recordSearch() {
  const { origin, filters } = state;
  const typeOption = els.type.selectedOptions[0];
  addToHistory({
    source: origin.source,
    postcode: origin.postcode || '',
    area: origin.area || '',
    // Same precision as the shareable URL: ~100 m for device locations, ~10 m for map picks.
    lat: origin.source === 'device' ? Math.round(origin.lat * 1e3) / 1e3 : origin.lat,
    lng: origin.source === 'device' ? Math.round(origin.lng * 1e3) / 1e3 : origin.lng,
    radius: filters.radius,
    rating: filters.rating,
    businessType: filters.businessType,
    businessTypeName: filters.businessType && typeOption ? typeOption.textContent : '',
    total: state.total,
  });
  renderRecent();
}

/** Up to four recent searches under the search box, plus a link to the full history. */
function renderRecent() {
  const entries = getHistory().slice(0, 4);
  els.recent.hidden = !entries.length;
  if (!entries.length) { els.recent.innerHTML = ''; return; }
  els.recent.innerHTML = `
    <h2 class="recent__label">Recent</h2>
    <ul class="recent__list">
      ${entries.map((e) => {
        const d = describeEntry(e);
        // Compact chip: an icon plus the postcode; the full description is the accessible name and tooltip.
        const full = [d.title, d.area, d.filters].filter(Boolean).join(' · ');
        const icon = e.source === 'postcode' ? '' : `<svg class="chip__icon" viewBox="0 0 20 20" aria-hidden="true">${e.source === 'device'
          ? '<circle cx="10" cy="10" r="3" fill="currentColor"/><circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/>'
          : '<path d="M10 17.5s-5.5-5-5.5-9a5.5 5.5 0 0 1 11 0c0 4-5.5 9-5.5 9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="10" cy="8.5" r="2" fill="currentColor"/>'}</svg>`;
        const short = e.postcode || d.title;
        return `<li><a class="chip chip--link" href="${escapeHtml(historyUrl(e))}" title="${escapeHtml(full)}" aria-label="${escapeHtml(full)}">${icon}${escapeHtml(short)}</a></li>`;
      }).join('')}
    </ul>
    <a class="recent__all" href="history.html">All history</a>`;
}

/** The first search after opening a shared link uses its ?p= page; later searches start at 1. */
function takeInitialPage() {
  const page = state.initialPage;
  state.initialPage = 1;
  return page;
}

/** Scroll so the top of the results is visible (the list pane scrolls on desktop, the window on phones). */
function showResultsTop() {
  const behavior = prefersReducedMotion ? 'auto' : 'smooth';
  if (window.matchMedia('(min-width: 960px)').matches) {
    document.querySelector('.list-pane').scrollTo({ top: 0, behavior });
  } else {
    els.heading.scrollIntoView({ behavior, block: 'start' });
  }
}

function renderPager() {
  const { page, totalPages } = state;
  if (totalPages <= 1) {
    els.pager.hidden = true;
    els.pager.innerHTML = '';
    return;
  }
  const arrow = (dir) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${dir === 'prev' ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5'}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const numbers = pageWindow(page, totalPages).map((p) => (p === null
    ? '<li class="pager__gap" aria-hidden="true">…</li>'
    : `<li><button type="button" class="pager__num" data-page="${p}"${p === page ? ' aria-current="page"' : ''} aria-label="Page ${p}${p === totalPages ? ', last page' : ''}">${p}</button></li>`)).join('');

  els.pager.hidden = false;
  els.pager.innerHTML = `
    <p class="pager__status">Page ${page} of ${totalPages.toLocaleString('en-GB')}</p>
    <div class="pager__row">
      <button type="button" class="pager__step" data-page="${page - 1}"${page <= 1 ? ' disabled' : ''}>${arrow('prev')}Previous<span class="visually-hidden"> page</span></button>
      <ul class="pager__nums">${numbers}</ul>
      <button type="button" class="pager__step" data-page="${page + 1}"${page >= totalPages ? ' disabled' : ''}>Next<span class="visually-hidden"> page</span>${arrow('next')}</button>
    </div>`;
}

/** Items without coordinates keep the API's order but go after mapped ones at the same rank. */
function sortByDistance(list) {
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.distance ?? Infinity) - (b.p.distance ?? Infinity) || a.i - b.i)
    .map(({ p }) => p);
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
    await loadEstablishments(takeInitialPage());
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
      area: near?.area || '',
      country: near?.country || null,
      label: near ? `${what} (near ${near.postcode})` : what,
    };
    els.input.value = near ? near.postcode : '';
    setScheme(near?.country === 'Scotland' ? 'fhis' : 'fhrs');
    if (source === 'device') revealResultsOnMobile(); // a map pick: the map is already on screen
    await loadEstablishments(takeInitialPage());
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

els.pager.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-page]');
  if (!btn || btn.disabled || btn.getAttribute('aria-current')) return;
  const page = Number(btn.dataset.page);
  if (page >= 1 && page <= state.totalPages) loadEstablishments(page, { fromPager: true });
});

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

/**
 * Read search settings from URL parameters (a shared link, a reload or a
 * history entry). Only values the UI could have produced are accepted.
 */
function restoreFromParams(params) {
  const radius = Number(params.get('r'));
  state.filters.radius = [1, 2, 5].includes(radius) ? radius : 1;
  document.getElementById(`r${state.filters.radius}`).checked = true;
  const rating = params.get('rating') || '';
  const knownRatings = [...RATING_FILTERS.fhrs, ...RATING_FILTERS.fhis].map((o) => o.value);
  state.filters.rating = knownRatings.includes(rating) ? rating : '';
  const page = Number(params.get('p'));
  state.initialPage = Number.isInteger(page) && page >= 1 && page <= 1000 ? page : 1;
  const type = params.get('type') || '';
  state.filters.businessType = /^\d{1,6}$/.test(type) ? type : '';
  els.type.value = state.filters.businessType;
  if (els.type.value !== state.filters.businessType) state.filters.businessType = ''; // unknown type id
  // Scottish filter values are words ("Pass"), FHRS ones are digits.
  setScheme(/^[a-z]/i.test(state.filters.rating) ? 'fhis' : 'fhrs');
}

/** Run the search described by URL parameters. Returns false if they don't describe one. */
function searchFromParams(params) {
  restoreFromParams(params);
  const lat = parseFloat(params.get('lat'));
  const lng = parseFloat(params.get('lng'));
  if (params.get('pc')) {
    els.input.value = formatPostcode(params.get('pc'));
    searchPostcode(params.get('pc'));
    return true;
  }
  if (inUk(lat, lng)) {
    searchByCoords(lat, lng, 'map'); // a shared link: treat it as a picked point, not the viewer's location
    return true;
  }
  return false;
}

// Recent searches re-run in place rather than reloading the page.
els.recent.addEventListener('click', (e) => {
  const link = e.target.closest('a.chip--link');
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let "open in new tab" work
  e.preventDefault();
  searchFromParams(new URL(link.href).searchParams);
});

async function init() {
  initSettings({ onHistoryChange: renderRecent });
  showMapHint();
  renderRecent();
  await loadBusinessTypes(); // so a restored business-type filter is selectable
  if (!searchFromParams(new URLSearchParams(location.search))) setStatus('intro');
}

init();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  });
}
