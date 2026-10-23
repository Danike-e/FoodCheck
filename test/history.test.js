import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage for Node
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const {
  addToHistory, getHistory, removeFromHistory, clearHistory, historyUrl, describeEntry,
  isHistoryEnabled, setHistoryEnabled, MAX_ENTRIES,
} = await import('../public/js/history.js');

beforeEach(() => store.clear());

test('adds newest first and de-duplicates by place', () => {
  addToHistory({ source: 'postcode', postcode: 'G3 7TF', area: 'Glasgow City', radius: 1, at: 1 });
  addToHistory({ source: 'postcode', postcode: 'SW1A 1AA', radius: 2, at: 2 });
  addToHistory({ source: 'postcode', postcode: 'G3 7TF', radius: 5, rating: 'Pass', at: 3 });
  const list = getHistory();
  assert.deepEqual(list.map((e) => e.postcode), ['G3 7TF', 'SW1A 1AA']);
  assert.equal(list[0].radius, 5, 'latest filters win');
  assert.equal(list[0].rating, 'Pass');
});

test('keeps at most MAX_ENTRIES', () => {
  for (let i = 0; i < MAX_ENTRIES + 10; i++) addToHistory({ source: 'map', lat: 55 + i / 100, lng: -3, at: i });
  assert.equal(getHistory().length, MAX_ENTRIES);
});

test('remove, clear and the off switch', () => {
  const a = addToHistory({ source: 'postcode', postcode: 'EH1 1YZ' });
  addToHistory({ source: 'device', lat: 55.953, lng: -3.188, postcode: 'EH1 3EG' });
  removeFromHistory(a);
  assert.equal(getHistory().length, 1);
  clearHistory();
  assert.equal(getHistory().length, 0);
  setHistoryEnabled(false);
  assert.equal(isHistoryEnabled(), false);
  assert.equal(addToHistory({ source: 'postcode', postcode: 'G3 7TF' }), null);
  assert.equal(getHistory().length, 0);
  setHistoryEnabled(true);
  assert.equal(isHistoryEnabled(), true);
});

test('ignores tampered or malformed storage', () => {
  store.set('foodcheck:history', JSON.stringify([
    { source: 'postcode', postcode: '<img src=x onerror=alert(1)>' },
    { source: 'evil', postcode: 'G3 7TF' },
    { source: 'map', lat: 'x', lng: 1 },
    { source: 'postcode', postcode: 'G3 7TF', radius: 999, rating: '<b>', businessType: '1;drop', area: 7 },
    'nonsense',
  ]));
  const list = getHistory();
  assert.equal(list.length, 2);
  assert.doesNotMatch(list[0].postcode, /[<>=]/);
  assert.deepEqual([list[1].radius, list[1].rating, list[1].businessType, list[1].area], [1, '', '', '']);
  store.set('foodcheck:history', '{not json');
  assert.deepEqual(getHistory(), []);
});

test('builds re-run URLs and descriptions', () => {
  const pc = addToHistory({ source: 'postcode', postcode: 'SW1A 1AA', radius: 2, rating: '4', businessType: '1', businessTypeName: 'Restaurant/Cafe/Canteen' });
  assert.equal(historyUrl(pc), './?pc=SW1A1AA&r=2&rating=4&type=1');
  assert.deepEqual(describeEntry(pc), { title: 'SW1A 1AA', area: '', filters: '2 miles · rated 4+ · Restaurant/Cafe/Canteen' });
  const map = addToHistory({ source: 'map', lat: 55.95331234, lng: -3.18834567, postcode: 'EH1 1YZ' });
  assert.equal(historyUrl(map), './?lat=55.9533&lng=-3.1883');
  assert.equal(describeEntry(map).title, 'Point on map near EH1 1YZ');
});
