# FoodCheck

Find food hygiene ratings near any UK postcode, on a map and in a list.

Enter a postcode, use your location, or press and hold anywhere on the map (right-click on desktop) to see nearby restaurants, takeaways, shops and other food businesses. Each one is colour-coded by its latest Food Standards Agency (FSA) inspection result, and the number or text is always shown too.

- **England, Wales and Northern Ireland** use the 0–5 Food Hygiene Rating Scheme.
- **Scotland** uses the Food Hygiene Information Scheme: *Pass* or *Improvement Required*.

The site is plain HTML, CSS and JavaScript with no build step and no runtime dependencies. It installs as a PWA on iOS, Android and desktop, and deploys to Vercel as static files plus one small serverless function.

## Before you launch

The legal pages contain two placeholders you must fill in. Search `public/*.html` for each one:

- `[Operator name]`: your name, or your company's registered name.
- `[contact email]`: an address you check, for privacy and accessibility requests.

The privacy policy and terms are written to match exactly what FoodCheck does. They are a sensible starting point, not legal advice, so have them reviewed if you're running FoodCheck as a business.

## Run it locally

You need [Node.js](https://nodejs.org/) 20 or newer. There are no dependencies to install.

```bash
npm start            # dev server on http://localhost:3000 (PORT=8080 to change)
npm test             # security test suite
```

The dev server listens on `127.0.0.1` only. Set `HOST=0.0.0.0` to try it from a phone on your network. It sends the same security headers as production.

## Deploy to Vercel

1. Import the repo in Vercel. No framework preset, build command or install step is needed; `vercel.json` sets all of it.
2. Deploy. Vercel serves `public/` as static files and turns `api/fsa.js` into a serverless function.

There are no environment variables or secrets: both data APIs are free and keyless.

### Why plain static files and not Next.js or Bun

FoodCheck is a single client-side page with nothing to render on a server. Next.js would add hundreds of transitive packages, each one a supply-chain and patching burden, for no user-facing gain. Recent Next.js CVEs include a middleware auth bypass and a React Server Components remote code execution bug. Bun isn't needed either, since nothing gets built. With no runtime dependencies there is nothing to `npm audit` and nothing to keep patched.

### The proxy

The browser calls the FSA API directly; it allows cross-origin requests. `/api/fsa/Establishments` and `/api/fsa/BusinessTypes` are a fallback the app switches to only if a direct request fails at the network level. The proxy adds the required `x-api-version: 2` header. Successful responses carry `s-maxage=3600`, so Vercel's CDN caches them for an hour and repeat searches never invoke the function. The local server caches in memory instead. Both use the same code in `lib/fsa-proxy.js`.

## How it works

| Step | Source |
| --- | --- |
| Postcode → coordinates | `GET https://api.postcodes.io/postcodes/{postcode}` (404 means invalid) |
| Device location or a point held on the map → nearest postcode | `GET https://api.postcodes.io/postcodes?lat=…&lon=…` |
| Nearby businesses | `GET https://api.ratings.food.gov.uk/Establishments?latitude=…&longitude=…&maxDistanceLimit=…&sortOptionKey=distance&pageSize=100` |
| Business type filter | `GET https://api.ratings.food.gov.uk/BusinessTypes` (cached in `localStorage` for a week) |

Things worth knowing about the FSA API:

- The rating filter only works with short keys (`5`, `4`, …, `Pass`, `ImprovementRequired`). The long `fhrs_4_en-gb` style keys are silently ignored. For 0–5 ratings the app sends `ratingOperatorKey=GreaterThanOrEqual`, so "4 or better" works.
- A missing inspection date comes back as `0001-01-01` or `1901-01-01`.
- The API's own `Distance` field is unreliable, so distances are worked out in the browser from the searched point.
- Busy areas can have thousands of results within a mile (27,000+ within 5 miles of central London). Results are paginated 50 per page, nearest first, with Previous / Next and numbered pages. The map shows the current page's pins, and the page number is kept in the URL (`?p=3`). The FSA API returns pages in distance order, so the pages run continuously.

Businesses with no coordinates stay in the list, marked "No map location", and don't get a pin.

## Project structure

```
public/                   Everything the browser can load (Vercel output directory)
  index.html              App page (search, map, list, settings dialog)
  about.html              About / landing page: what FoodCheck does, ratings explained, install, FAQ
  img/demo/               Screenshots for the About page's animated iPhone walkthrough
  history.html            Search history page
  privacy.html            Privacy policy
  terms.html              Terms of use
  accessibility.html      Accessibility statement
  css/styles.css          All styles (light + dark, mobile first)
  css/fonts.css           Self-hosted font faces
  js/app.js               UI controller: search, map, list, selection, states
  js/api.js               postcodes.io + FSA API calls, proxy fallback
  js/ratings.js           Rating → colour / label / description, filter options
  js/back-to-top.js       Floating “back to top” button on phones and tablets (all pages)
  js/about-demo.js        About page: animated "how it works" walkthrough on an iPhone
  js/history.js           Search history storage (localStorage, validated on read)
  js/history-page.js      History page: grouped by day, re-run, remove, clear, on/off
  js/settings.js          Settings dialog: light / dark / match device, clear saved data
  js/theme-init.js        Applies the saved theme before first paint (no flash)
  sw.js                   Service worker (offline app shell, recent results offline)
  manifest.webmanifest    PWA manifest
  icons/                  App icons (SVG + PNG, maskable, apple-touch)
  vendor/leaflet/         Leaflet 1.9.4 (BSD-2-Clause)
  vendor/fonts/           DM Sans + Source Serif 4 variable fonts (OFL)
api/fsa.js                Vercel Function: FSA proxy fallback
lib/fsa-proxy.js          Proxy validation + upstream call (shared)
lib/security-headers.js   CSP and other headers (mirrored in vercel.json)
server.js                 Local dev server
vercel.json               Vercel config: output dir, rewrite, headers
test/security.test.js     Security tests (node:test, no network needed)
```

## Security

| Area | What's in place |
| --- | --- |
| **XSS** | Every API-supplied string is HTML-escaped before rendering. Other template values come from fixed lookup tables. URL parameters are checked against allow-lists before use. Tested by feeding script-laden business names, addresses and IDs through a mocked API. |
| **Content Security Policy** | `script-src 'self'` with no `unsafe-inline` or `unsafe-eval`, and no inline scripts or styles anywhere. Only the two data APIs and the OSM tile server are allowed. `object-src`, framing and `<base>` hijacking are blocked. |
| **Other headers** | HSTS, `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` (location only for this site; camera, mic and payment off), COOP and CORP. |
| **Proxy abuse** | Only two endpoints are reachable. Every parameter is type- and range-checked: UK-only coordinates, radius 1/2/5, page size ≤ 100, page ≤ 50. Unknown or duplicated parameters are rejected, and the upstream URL is rebuilt from the parsed values. Responses must be JSON under 2 MB, and redirects are refused. Errors are generic. Invalid requests never reach the FSA. |
| **Third parties** | No CDNs, analytics or Google Fonts. Leaflet and the fonts are self-hosted, so the only outside requests go to postcodes.io, the FSA and OpenStreetMap tiles. |
| **Privacy** | Device location is used only on request. It is rounded to about 10 m before being sent to postcodes.io and the FSA, and to about 100 m in the shareable URL. Nothing is stored server-side, and there are no cookies. **Settings → Clear saved data** wipes everything kept on the device. |
| **Links** | External links use `rel="noopener noreferrer"`. |
| **Dev server** | Serves only `public/`, never dotfiles. It survives malformed URLs (the first version crashed on one), listens on localhost by default, and accepts only GET and HEAD. |
| **Dependencies** | None at runtime, and none at build time. |

Optional hardening on Vercel:
- Add a rate-limit rule for `/api/fsa/*` in the Vercel Firewall.
- Once you're on a custom domain you control fully, add `includeSubDomains; preload` to HSTS.



## Design notes

- The palette is warm paper and clay, with a serif display face (Source Serif 4) paired with DM Sans. Claude's own typefaces are proprietary, so these are close free alternatives, self-hosted.
- Rating colours were chosen so the text on each badge meets WCAG AA contrast. Colour is never the only signal: badges and pins always show the number, ✓ / ! or text, and each card spells out what the rating means ("Generally satisfactory").
- The map has a **full-screen** button (top right). It expands the map to fill the window using CSS rather than the Fullscreen API, which iPhone Safari only allows for video, so it works the same on every device and in the installed app. The rest of the page is made `inert` while it's open, and Escape or the button closes it.
- On phones the map sits above the list and stays pinned while you scroll, so tapping a card always shows its pin. From 960px wide, the sidebar holds search and results and the map fills the rest of the screen.
- **Search history:** each place searched is saved on the device only. That covers a postcode, your location (rounded to about 100 m) or a point on the map. The latest filters are kept, and the history holds at most 50 entries. The four most recent appear as chips under the search box and re-run in place. The **History** page groups everything by day and lets you search again, remove single entries or clear it all. History can be switched off in Settings or on the History page, and switching it off deletes what was saved.
- **Settings** offers Light, Dark or Match device. The choice is saved on the device and applied before the page paints, so there's no flash, on every page.
- **Accessibility:** the app targets WCAG 2.2 AA. It has zero axe-core violations on every page and state, in both themes. Text meets 4.5:1 contrast and form controls 3:1. It works by keyboard with visible focus, uses a native modal `<dialog>` for settings, live regions for results, and reflows to 320 px. See `public/accessibility.html`.
- The input is 17px so iOS doesn't zoom on focus. The layout respects safe areas (`viewport-fit=cover`), and dark mode and reduced motion are supported.
- Searches are kept in the URL (`?pc=G37TF&r=2&rating=4`), so results can be bookmarked and shared.

## Testing

`npm test` runs the security suite: proxy validation, upstream error handling, header config and dev-server hardening.

For a manual check, try `G3 7TF` (Glasgow), `SW1A 1AA` (London) and `EH1 1YZ` (Edinburgh). The two Scottish postcodes use Pass / Improvement Required instead of 0–5.

## Attribution

Contains public sector information licensed under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Data from the [Food Standards Agency](https://ratings.food.gov.uk/). Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Postcode data from [postcodes.io](https://postcodes.io/). Maps by [Leaflet](https://leafletjs.com/) (BSD-2-Clause). Fonts: DM Sans and Source Serif 4 (SIL Open Font License 1.1).

FoodCheck is an independent tool and isn't affiliated with the Food Standards Agency.
