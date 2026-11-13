# Pinboard Bridge

A CORS-enabled proxy service for the Pinboard API with enhanced security features.

## Features

- **CORS Support**: Configurable cross-origin resource sharing with JSON error responses
- **Security Headers**: Helmet.js integration for secure HTTP headers
- **Rate Limiting**: 300 requests per 15 minutes per IP address (matching Pinboard's own one-call-per-three-seconds guidance); CORS preflights are not counted
- **Compressed Responses**: gzip/brotli via `compression`, which shrinks a large account's `/v1/tags/get` by roughly 80%
- **Preflight Caching**: `Access-Control-Max-Age` lets browsers skip the CORS preflight on repeat requests
- **Header-based Authentication**: Keeps Pinboard credentials out of URLs
- **XML to JSON Conversion**: Automatic XML response conversion using fast-xml-parser
- **Health Check Endpoint**: Monitor service status at `/health`
- **Graceful Shutdown**: Proper handling of SIGTERM/SIGINT signals
- **Error Handling**: Comprehensive error handling with consistent JSON responses
- **Preview API**: Server-side endpoint that scrapes Twitter/Open Graph metadata alongside Pinboard suggestions
- **Preview Thumbnails**: `/preview?thumbnails=1` also returns the page's image and icon as small `data:` URIs, for clients that can't load remote images

## Requirements

- Node.js 24.x (pinned in `engines`; runs on the Heroku-26 stack)
- npm 11+
- Your Pinboard API token (`username:XXXXXX` as shown in Pinboard settings). The bridge does **not** accept raw account passwords.

## Installation

```bash
git clone git@github.com:rossshannon/pinboard-bridge.git
cd pinboard-bridge
npm install
cp .env.example .env
```

## Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | 1337 | No |
| `NODE_ENV` | Environment mode | development | No |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins | (all origins) | No |
| `IP_RATE_LIMIT_MAX` | Requests allowed per source IP per 15 minutes on `/v1/*` | 300 | No |
| `PREVIEW_RATE_LIMIT_MAX` | `/posts/suggest-with-preview` requests allowed per IP per minute | 20 | No |
| `PAGE_PREVIEW_RATE_LIMIT_MAX` | `/preview` requests allowed per IP per minute | 60 | No |
| `PINBOARD_MIN_INTERVAL_MS` | Minimum gap between the starts of two Pinboard calls for the same user (`0` turns spacing off) | 3000 | No |
| `PINBOARD_MAX_QUEUE_MS` | Longest a call will wait for its slot; a call that would wait longer is sent straight away. Capped at the budget below minus 5 s | 9000 | No |
| `PINBOARD_TOTAL_BUDGET_MS` | Longest a Pinboard call may take, queueing included, before the bridge answers 504 (at least 1000) | 25000 | No |

Numeric settings must be whole numbers; anything else (`-1`, `1e3`, `300ms`) is ignored with a warning and the default is used.

**CORS strategy:** The bridge still allows every origin if `ALLOWED_ORIGINS` is unset (for backwards compatibility with self-hosted setups). For any public deployment you should list the exact origins that are allowed to call the proxy. The sample `.env.example` defaults to the Pincushion frontend at `https://rossshannon.github.io`:

```bash
ALLOWED_ORIGINS=https://rossshannon.github.io
```

### Authentication Policy

- Browser/extension clients **must** send credentials through the `Authorization` header.
- Incoming `auth_token` query parameters are stripped before forwarding to Pinboard, preventing accidental leaks through logs, history, or shared URLs.
- `Authorization: Basic <base64(username:token)>` → proxied upstream using HTTP Basic. (Base64 encode the literal `username:token` string provided by Pinboard.)
- `Authorization: Bearer username:token` → rewritten as the upstream `auth_token` query parameter and kept out of browser-visible URLs.

### Rate Limiting

- 300 requests per 15 minutes are allowed per source IP on `/v1/*`. This mirrors Pinboard's published guidance of one call per user per three seconds. Heroku users should ensure `app.set('trust proxy', 1)` remains enabled so the limiter sees client IPs.
- CORS preflight (`OPTIONS`) requests are not counted. Browsers must preflight every call because of the `Authorization` header, so counting them would halve the usable budget.
- When throttled, responses include standard `RateLimit-*` headers so the UI can surface “retry-after” information.
- `/posts/suggest-with-preview` adds a per-IP limiter (20 requests/minute) to prevent abusive preview scraping and to stay within Pinboard's own limits. `/preview` makes no Pinboard call, so its limit is looser (60 requests/minute per IP). Both also count against the per-IP limit above. They are keyed on the IP rather than the `Authorization` header, which isn't checked against Pinboard on these routes, so changing the header doesn't buy a fresh allowance.
- `/preview` only checks that an `Authorization` header is well formed; it doesn't ask Pinboard whether the credentials are real, since that would cost a Pinboard call. Anyone can use it as a page-head fetcher within the per-IP limit.
- Pinboard asks for at most one call per user every three seconds. The bridge spaces calls for the same user that far apart (start to start) by holding a later call until its slot. A call that would have to wait more than `PINBOARD_MAX_QUEUE_MS` is sent straight away instead, so a burst never queues towards Heroku's 30-second router timeout, and time spent waiting is taken off the call's 25-second Pinboard budget, leaving room inside the router timeout. If the client disconnects while its call is queued, the call is dropped rather than sent. Slots are keyed on the whole `Authorization` header, so a request with someone else's username and a wrong token can't use up their slots. Spacing lives in each dyno's memory: with more than one web dyno, or across a restart, calls are only spaced per dyno.

### Response Compression and Preflight Caching

- Responses are gzip/brotli compressed when the client sends `Accept-Encoding`. Heroku's router does not compress on your behalf, and `/v1/tags/get` for an account with thousands of tags is a couple of hundred kilobytes of JSON uncompressed.
- Preflight responses include `Access-Control-Max-Age: 86400`, so a browser only pays the extra round trip once per URL (Chrome caps the cache at two hours).
- Every response is sent with `Cache-Control: no-store` and without an ETag. The bridge only ever returns a private view of one account, so a browser's HTTP cache must never hold it; the preflight cache above is unaffected.

## Running Locally

```bash
npm run dev
# or specify env vars
PORT=1337 ALLOWED_ORIGINS=https://rossshannon.github.io npm start
```

Health check:

```bash
curl http://localhost:1337/health
```

Proxy usage example (Pinboard “all posts” endpoint using an auth token exposed through Bearer):

```bash
curl \
  -H "Origin: https://rossshannon.github.io" \
  -H "Authorization: Bearer username:YOURTOKEN" \
  "http://localhost:1337/v1/posts/all?format=json"
```

## API Surface

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns service status, uptime, and timestamp. Useful for uptime monitors. |
| `GET` | `/v1/*` | Forwards requests to `https://api.pinboard.in` with the same path/query, after injecting auth info and normalizing responses. |
| `GET` | `/preview` | Fetches preview metadata (Twitter Card/Open Graph) for the supplied URL. Makes no Pinboard call. With `thumbnails=1`, also returns the page's image and icon as small `data:` URIs. |
| `GET` | `/posts/suggest-with-preview` | Calls Pinboard’s `posts/suggest` and, in parallel, fetches preview metadata for the supplied URL. Answers once both are done; kept for older clients. |

Responses default to JSON. If Pinboard returns XML (the default), the bridge converts it to JSON via `fast-xml-parser` before sending the response back to the browser.

### `/preview`

Returns the `preview`, `previewStatus` and `previewError` fields described below, without the Pinboard suggestions. It takes the same `url` parameter and `Authorization` header as `/posts/suggest-with-preview`. Pinboard's `posts/suggest` can take 15 seconds or more for a URL it hasn't seen before, so clients that show a preview should call this and `/v1/posts/suggest` separately rather than wait on the combined route.

The bridge reads the page only as far as `</head>` (or 512 KB), and gives up on the whole fetch, redirects included, after 5 seconds.

#### Thumbnails (`thumbnails=1`)

Some clients can only show images given to them as `data:` URIs (a sandboxed card whose content security policy allows nothing else, for example). Adding `thumbnails=1` to a `/preview` request adds two fields beside the usual ones:

```json
{
  "preview": { "title": "Amazing Gadget", "imageUrl": "https://example.com/images/gadget.png", "…": "…" },
  "previewStatus": "fresh",
  "thumbnails": {
    "image": { "dataUri": "data:image/webp;base64,…", "width": 240, "height": 126 },
    "favicon": { "dataUri": "data:image/png;base64,…", "width": 32, "height": 32 }
  },
  "thumbnailsStatus": "complete"
}
```

- `image` is made from `preview.imageUrl`: scaled to fit inside 240×240 and encoded as WebP. `favicon` is scaled to fit inside 32×32 and encoded as PNG. Neither is ever enlarged, so `width` and `height` can be smaller than those limits. Animated images give a single still frame.
- `favicon` comes from the icons the page declares, tried in order of preference (`apple-touch-icon`, a typed PNG icon, then plain `icon` and `shortcut icon` links), up to three of them, and then from `/favicon.ico` on the origin the page was finally served from. SVG and mask icons are skipped, since they are never decoded, so the icon used can differ from `preview.faviconUrl`, which is unchanged.
- Either is `null` when there is nothing to show or it couldn't be made. A thumbnail that fails never fails the request or changes `preview` and `previewStatus`. A page with no preview data (`"preview": null`, `"previewStatus": "no_data"`) can still have a `favicon`.
- A link that answers with something other than HTML (a PDF, an image) has no preview (`previewStatus` is `error`), but `/favicon.ico` on its origin is still tried, so it can have a `favicon` too. A page that failed in any other way gets two `null`s and nothing further is fetched.
- Any other value of `thumbnails`, or none, leaves the response exactly as it was.

`thumbnailsStatus` says how far to trust a `null`, and so how long a client should keep the answer:

| Value | Meaning | Keep it? |
|-------|---------|----------|
| `complete` | Every answer is settled: the thumbnail was made, or there is none to be had (no image declared, a 404, not an image, too large, a refused host). Also given when the page itself failed for good: a 4xx other than 408 and 429, or a host the bridge won't call. | Yes |
| `transient` | Something failed in passing: a timeout, a network error, a 5xx, 429 or 408, or a decode that ran out of time, whether it was an image or the page itself. | Briefly; ask again |
| `busy` | Too many thumbnail requests were in flight (see below). Thumbnails already in the cache are still given; the rest are `null` and were not tried. | No; ask again shortly |
| `unavailable` | This bridge can't make thumbnails at all: its image library failed to load. Everything else works as usual. | No |

Limits, since every image URL is chosen by the page being previewed:

| Limit | Value |
|-------|-------|
| Whole request, page fetch included | 7 s (allow a little more, say 8.5 s, before giving up client-side) |
| Page fetch | 5 s, read as far as `</head>` or 512 KB |
| Image and icon together | 4 s, or what is left of the 7 s if less; with under 0.5 s left only the cache is consulted |
| Image body | 2 MB, after any decompression |
| Icon body | 512 KB, after any decompression |
| Image size | 9 megapixels and 36 MB once decoded (so a 16-bit image is allowed half the area) |
| Icon size | 2 megapixels and 8 MB once decoded; `.ico` entries up to 256×256 |
| Formats | PNG, JPEG, GIF and WebP; also `.ico` for icons (bitmap entries of 1, 4, 8, 24 or 32 bits, or embedded PNGs; up to three entries of a file are tried) |
| Redirects | 3 per fetch |
| Icons tried | 3 declared, then `/favicon.ico` |
| Thumbnail requests fetching at once | 8 per client IP, 16 in all; beyond that `busy` |
| Decodes at once | 2, with turns shared fairly between clients |
| Cache | 500 thumbnails or 16 MB, kept 6 hours; a URL that gave none is left alone for 5 minutes |

- Images are fetched under the same rules as the page: `http`/`https` only, never a private or loopback host (by name, by DNS or by redirect), over connections that are never kept alive.
- Formats are judged by a file's first bytes rather than by `Content-Type`. SVG is never accepted, and neither are AVIF and HEIF: their decoder can be made to hold hundreds of megabytes by a file of a few hundred bytes. A file past the size limits is refused from its header, before any of it is decoded.
- The size limits are what keep memory in hand on a 512 MB dyno. Measured with two decodes at once of the costliest file each format allows (interlaced PNG, 16-bit PNG and GIF are the worst), peak memory rose by about 115 MB over an idle process.
- The decode time limit (3 s) is a backstop only; libvips can't interrupt a decoder part-way. What bounds a decode is the limits above: the slowest file they allow decodes in about a tenth of a second.
- What comes back is always the bridge's own re-encoding, with the original's metadata (EXIF, colour profiles and so on) dropped.
- A URL that is both the image and an icon is fetched once, and requests that want the same image at the same moment (several pages of one site, say) share one fetch and one decode. Work a request leaves behind at its deadline carries on, within its own 4 seconds, and is cached for the next request.
- A freed decoding turn goes to the waiting client that holds fewest, so one client's backlog can't keep both turns from everyone else.
- Rendered thumbnails are kept in memory, per dyno, keyed on the image's URL, so an icon or default image shared across a site is fetched and decoded once. The page itself is fetched on every request and its `preview` is never cached. Requests without `thumbnails=1` never use the cache, and every response still carries `Cache-Control: no-store`.
- The `[preview]` log line gains the status and, for each thumbnail, an outcome and time: `thumbs=complete image=ok imageSource=declared imageMs=41 favicon=ok faviconSource=fallback faviconMs=12`, with `imageCache=hit` or `faviconCache=hit` when the answer came from the cache. Outcomes other than `ok` are `none` (nothing to fetch), `blocked`, `too_large`, `unsupported`, `undecodable`, `http_404` and the like, `timeout`, `decode_timeout`, `error`, `busy`, `unavailable` and `no_page`.

### `/posts/suggest-with-preview`

This endpoint keeps preview scraping on the server (no extra browser permissions) while returning the same suggestions data as Pinboard’s `posts/suggest`.

**Query parameters**

- `url` (required): The bookmark target. Must be `http://` or `https://` and cannot point to localhost/loopback/RFC1918 hosts.

**Authentication**

- Same `Authorization` header scheme as the other routes (Basic or Bearer, both using `username:token`). Incoming `auth_token` query params are ignored.

**Response structure**

```json
{
  "suggestions": { "popular": [], "recommended": [] },
  "preview": {
    "url": "https://example.com/article",
    "title": "Amazing Gadget",
    "description": "All the reasons it is amazing.",
    "imageUrl": "https://example.com/images/gadget.png",
    "siteName": "Example News",
    "siteHandle": "@example",
    "siteHandleUrl": "https://twitter.com/example",
    "siteDomain": "example.com",
    "cardType": "summary_large_image",
    "themeColor": "#0a84ff",
    "faviconUrl": "https://example.com/favicon.ico",
    "fetchedAt": "2025-11-15T20:05:00.000Z"
  },
  "previewStatus": "fresh",
  "previewError": "optional explanation when preview scraping fails"
}
```

`preview` is omitted (or `null`) when no metadata is found. If the metadata fetch fails entirely (timeout, unsupported MIME type, invalid URL, etc.), the endpoint still returns the Pinboard suggestions but adds a `previewError` string and sets `previewStatus` to `error`. When data is returned straight from a fresh fetch, `previewStatus` is `fresh` (future updates may re-use this flag to signal cached responses). Whenever the site exposes a Twitter creator/site tag, the payload also includes `siteHandleUrl` so UIs can link to the social profile directly.

**Limits & logging**

- Preview fetches are limited to 20 requests per minute per IP on this route (`PREVIEW_RATE_LIMIT_MAX`), and 60 on `/preview`.
- A failed preview tells the client only what kind of failure it was (`Preview fetch timed out`, `Preview response is not HTML`, `URL host is not reachable from the proxy`, `Page returned HTTP 404`, or `Could not fetch the page`). The underlying error goes to the logs only, so the route can't be used to probe what the dyno can reach.
- Each request logs `{user, targetHost, outcome}` (`preview_generated`, `preview_not_found`, or `preview_failed`) to help spot misuse without storing the raw token, plus `suggestMs` and `previewMs`: how long each half took, as the user saw it (`suggestMs` includes any time spent waiting for the user's Pinboard slot).
- Every Pinboard call also logs a `[pinboard]` line with the endpoint, `waitMs` (time held for the user's slot) and `upstreamMs` (time Pinboard took).

## Deployment

### Heroku (recommended)

1. Provision an app on the `heroku-26` stack (`heroku create --stack heroku-26`, or `heroku stack:set heroku-26` on an existing app followed by a fresh deploy).
2. Set config vars (at minimum `NODE_ENV=production` and your chosen `ALLOWED_ORIGINS`).
3. Push the main branch:

   ```bash
   git push heroku main
   ```

4. Tail logs with `heroku logs --tail` if you need to debug startup issues. (This service intentionally avoids application-level request logging to keep credentials out of Heroku Logplex.)

### Other hosting providers

Any Node.js host that exposes port 1337 (or a configured alternative) works. Remember to configure reverse proxies (NGINX, Cloudflare, etc.) to forward `Authorization` headers untouched and to respect the rate-limiting proxy settings.

## Migration Notes (v1 → v2)

- Remove `auth_token` query params from all clients; instead send headers as described above.
- Because request logging was removed, make sure your external monitoring still captures health and latency (e.g., via uptime checks or reverse-proxy metrics).
- Update any infrastructure-as-code scripts to include the new default `ALLOWED_ORIGINS` or your production hostname.

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| `401 Authorization header required` | Missing/typoed `Authorization` header | Ensure the client always sends either Basic or Bearer credentials. |
| `401 Invalid Bearer authorization header` | Bearer token missing `username:` prefix | Format should be `username:token`, exactly as Pinboard displays under “API token”. |
| `403 Origin not allowed by CORS policy` | The requesting site is absent from `ALLOWED_ORIGINS` | Add the origin (scheme + host, optional port) to the env var or leave it blank for development. |
| `504 Gateway timeout` | Pinboard took longer than 30 seconds to respond | Retry later; Pinboard occasionally rate limits. Consider adding caching upstream. |
| `Too many requests` | Rate limiter tripped | Reduce polling frequency or implement client-side caching/backoff. |

## Security Features

- Helmet.js security headers
- CORS origin validation with explicit 403 JSON responses for disallowed origins
- Rate limiting per IP (300 per 15 minutes on `/v1/*`)
- Per-token preview throttling and structured preview logging
- Preview thumbnails fetched under the same SSRF guard as pages, size- and time-capped, limited to sniffed raster formats (no SVG, no AVIF) and always re-encoded
- 25-second budget for each Pinboard call, queueing included
- Sanitized error messages without leaking upstream responses
- Authorization headers only (tokens never logged in URLs)
- `Cache-Control: no-store` on every response, no ETags, so account data never lands in a browser cache

## Changelog

### Version 2.4.0
- Add `thumbnails=1` to `/preview`: the page's image (WebP, within 240×240) and icon (PNG, within 32×32) as `data:` URIs, with `/favicon.ico` as the fallback icon
- Report `thumbnailsStatus` (`complete`, `transient`, `busy` or `unavailable`) so a client knows whether a missing thumbnail is worth asking for again
- Fetch those images under the page fetcher's SSRF guard, with byte caps (2 MB and 512 KB), limits on decoded size, seven seconds for the whole request, eight requests at a time per client IP (sixteen in all), two decodes at a time shared fairly between clients, and an in-memory cache of rendered thumbnails keyed on the image URL
- Decode only PNG, JPEG, GIF, WebP and `.ico`, recognised by their first bytes; every other libvips loader, SVG and AVIF included, is switched off
- Add `sharp` 0.35 for decoding and re-encoding, loaded on first use so that a missing binary costs only the thumbnails
- Fetch pages and images over connections that are never kept alive, so none is left open to a host once its page has been read

### Version 2.3.0
- Add `/preview`, which returns page metadata without waiting on Pinboard's `posts/suggest`
- Space Pinboard calls for the same user three seconds apart, per Pinboard's guidance (`PINBOARD_MIN_INTERVAL_MS`, `PINBOARD_MAX_QUEUE_MS`)
- Read preview pages only as far as `</head>` (or `<body>`, for pages that leave the closing tag out, skipping look-alikes inside scripts, styles, titles, comments and nested templates), under one 5-second deadline for the whole fetch
- Tell clients only what kind of preview failure happened, keeping network error detail in the logs
- Give each Pinboard call a deadline for the whole response, not just for gaps in it (`PINBOARD_TOTAL_BUDGET_MS`, at least 1000 ms)
- Ignore numeric settings that aren't whole numbers, with a warning, instead of half-parsing them
- Harden the preview fetcher's SSRF guard: refuse hostnames that resolve to private addresses, redirects to private hosts, and `0.0.0.0/8`, `100.64.0.0/10`, reserved, benchmarking and multicast IPv4, link-local, site-local and multicast IPv6, and IPv6 forms that embed an IPv4 address (mapped, compatible, NAT64, 6to4, Teredo)
- Hang up on a preview page once its head has been read, or as soon as it turns out to be an error or not HTML
- Key the `/preview` and `/posts/suggest-with-preview` rate limits on the client IP, since the `Authorization` header isn't checked there
- Only return http(s) links in previews; resolve relative links and take the site domain from the page actually fetched
- Log how long Pinboard and the preview fetch each took, with usernames stripped of characters that could forge log lines
- Drop a queued Pinboard call as soon as its client disconnects, moving the calls behind it up the queue, and cap queueing plus the Pinboard call at 25 seconds

### Version 2.2.1
- Mount the per-IP limiter after CORS, so a 429 carries `Access-Control-Allow-Origin` and browsers can read it instead of seeing a network error; expose the `RateLimit-*` and `Retry-After` headers to browser clients
- Report `EAI_AGAIN`, `EHOSTUNREACH` and `ENETUNREACH` from Pinboard as 503 alongside the other network-layer failures, and a socket-level `ETIMEDOUT` as 504 like the existing request timeout
- Add a final JSON error handler, so an error after the CORS check (for example from the rate limiter) never returns Express's HTML error page; client errors keep their status and its standard text
- Correct the documented `ALLOWED_ORIGINS` to Pincushion's real origin, `https://rossshannon.github.io` (it said `.github.com`, which blocks Pincushion), and set it in `app.json`
- Reject non-integer, non-positive or too-large `IP_RATE_LIMIT_MAX`/`PREVIEW_RATE_LIMIT_MAX` with a startup warning instead of misreading them

### Version 2.2.0
- Move to the Heroku-26 stack (Ubuntu 26.04, supported until April 2031); `heroku.yml` and the new `app.json` both declare `heroku-26`
- Bump axios to 1.20, cheerio to 1.2, express to 4.22.3, fast-xml-parser to 5.11 and helmet to 8.3, clearing advisories in proxy-addr (critical), axios, form-data, undici, body-parser and qs

### Version 2.1.1
- Send `Cache-Control: no-store` on every response and disable Express ETags, so bookmark and tag JSON is never written to a browser's HTTP cache

### Version 2.1.0
- Compress responses with `compression` (gzip/brotli); `/v1/tags/get` shrinks by roughly 80% for large accounts
- Send `Access-Control-Max-Age` on preflight responses so browsers cache the CORS verdict
- Stop counting CORS preflights against the per-IP limiter, and raise that limit from 100 to 300 per 15 minutes to match Pinboard's own cadence (`IP_RATE_LIMIT_MAX` overrides it)

### Version 2.0.0
- Require Authorization headers and ignore inbound `auth_token` query parameters
- Support `Authorization: Bearer username:token` so clients can keep tokens out of URLs while Pinboard still receives `auth_token`
- Remove request logging to prevent credential exposure in logs
- Return JSON 403 responses for blocked origins
- Document recommended `ALLOWED_ORIGINS` value (`https://rossshannon.github.com`) and update `.env.example`
- Bump dependencies to drop unused logging package
- Add `/posts/suggest-with-preview` endpoint with URL validation, metadata parsing, and per-token throttling
- Include `themeColor`, `faviconUrl`, and `previewStatus` so the frontend can style cards and detect stale previews

### Version 1.2.0
- Updated dependencies (axios, express)
- Replaced sax2json with fast-xml-parser
- Added helmet for security headers
- Added express-rate-limit for rate limiting
- Added morgan for request logging
- Added configurable CORS with origin whitelist
- Added health check endpoint
- Added graceful shutdown handling
- Added request timeout (30s)
- Improved error handling and consistency
- Upgraded to Heroku stack heroku-24

### Version 1.1.1
- Previous stable release
