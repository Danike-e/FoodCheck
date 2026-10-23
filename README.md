# FoodCheck

Find food hygiene ratings near any UK postcode, on a map and in a list.

Enter a postcode, or use your location, to see nearby restaurants, takeaways, shops and other food businesses. Each one is colour-coded by its latest Food Standards Agency (FSA) inspection result, and the number or text is always shown too.

- **England, Wales and Northern Ireland** use the 0–5 Food Hygiene Rating Scheme.
- **Scotland** uses the Food Hygiene Information Scheme: *Pass* or *Improvement Required*.

The site is plain HTML, CSS and JavaScript with no build step. It installs as a PWA on iOS, Android and desktop.

## Run it locally

You need [Node.js](https://nodejs.org/) 18 or newer. There are no dependencies to install.

```bash
npm start            # or: node server.js
```

Then open <http://localhost:3000>. Set `PORT=8080` to use a different port.

Any static file server works too, for example `python3 -m http.server`. The FSA API currently allows browser requests, so the proxy below is optional. Opening `index.html` straight from disk (`file://`) won't work, because ES modules and the service worker need an HTTP origin.

### Why there's a small server

`server.js` does two things, and neither needs any packages:

1. It serves the static files.
2. It runs a cached proxy at `/api/fsa/Establishments` and `/api/fsa/BusinessTypes`. The proxy adds the required `x-api-version: 2` header and keeps responses in memory for an hour.

The browser calls the FSA API directly first. It only switches to the proxy if that request fails at the network level, for example if the FSA ever stops allowing cross-origin requests.

## How it works

| Step | Source |
| --- | --- |
| Postcode → coordinates | `GET https://api.postcodes.io/postcodes/{postcode}` (404 means invalid) |
| Device location → nearest postcode | `GET https://api.postcodes.io/postcodes?lat=…&lon=…` |
| Nearby businesses | `GET https://api.ratings.food.gov.uk/Establishments?latitude=…&longitude=…&maxDistanceLimit=…&sortOptionKey=distance&pageSize=100` |
| Business type filter | `GET https://api.ratings.food.gov.uk/BusinessTypes` (cached in `localStorage` for a week) |

Things worth knowing about the FSA API:

- The rating filter only works with short keys (`5`, `4`, …, `Pass`, `ImprovementRequired`). The long `fhrs_4_en-gb` style keys are silently ignored. For 0–5 ratings the app sends `ratingOperatorKey=GreaterThanOrEqual`, so "4 or better" works.
- A missing inspection date comes back as `0001-01-01` or `1901-01-01`.
- The API's own `Distance` field is unreliable, so distances are worked out in the browser from the searched point.
- Busy areas can have thousands of results within a mile. The app shows the nearest 100, and **Show more places** loads the next page.

Businesses with no coordinates stay in the list, marked "No map location", and don't get a pin.

## Project structure

```
index.html              Page markup
css/styles.css          All styles (light + dark, mobile first)
js/app.js               UI controller: search, map, list, selection, states
js/api.js               postcodes.io + FSA API calls, proxy fallback
js/ratings.js           Rating → colour / label / description, filter options
sw.js                   Service worker (offline app shell, last results offline)
manifest.webmanifest    PWA manifest
icons/                  App icons (SVG + PNG, maskable, apple-touch)
vendor/leaflet/         Leaflet 1.9.4 (bundled so the app works offline)
server.js               Optional static server + cached FSA proxy
```

## Design notes

- The palette is warm paper and clay, with a serif display face (Source Serif 4) paired with DM Sans. Claude's own typefaces are proprietary, so these are close free alternatives loaded from Google Fonts.
- Rating colours were chosen so the text on each badge meets WCAG AA contrast. Colour is never the only signal: badges and pins always show the number, ✓ / ! or text, and each card spells out what the rating means ("Generally satisfactory").
- On phones the map sits above the list and stays pinned while you scroll, so tapping a card always shows its pin. From 960px wide, the sidebar holds search and results and the map fills the rest of the screen.
- The input is 17px so iOS doesn't zoom on focus. The layout respects safe areas (`viewport-fit=cover`), and dark mode and reduced motion are supported.
- Searches are kept in the URL (`?pc=G37TF&r=2&rating=4`), so results can be bookmarked and shared.

## Testing

Try `G3 7TF` (Glasgow), `SW1A 1AA` (London) and `EH1 1YZ` (Edinburgh). The two Scottish postcodes use Pass / Improvement Required instead of 0–5.

## Attribution

Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Data from the [Food Standards Agency](https://ratings.food.gov.uk/). Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Postcode data from [postcodes.io](https://postcodes.io/). Maps by [Leaflet](https://leafletjs.com/) (BSD-2-Clause).

FoodCheck is an independent tool and isn't affiliated with the Food Standards Agency.
