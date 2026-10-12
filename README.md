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
| `PINBOARD_MAX_QUEUE_MS` | Longest a call will wait for its slot; a call that would wait longer is sent straight away | 9000 | No |

**CORS strategy:** The bridge still allows every origin if `ALLOWED_ORIGINS` is unset (for backwards compatibility with self-hosted setups). For any public deployment you should list the exact origins that are allowed to call the proxy. The sample `.env.example` defaults to the Pincushion frontend at `https://rossshannon.github.com`:

```bash
ALLOWED_ORIGINS=https://rossshannon.github.com
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
PORT=1337 ALLOWED_ORIGINS=https://rossshannon.github.com npm start
```

Health check:

```bash
curl http://localhost:1337/health
```

Proxy usage example (Pinboard “all posts” endpoint using an auth token exposed through Bearer):

```bash
curl \
  -H "Origin: https://rossshannon.github.com" \
  -H "Authorization: Bearer username:YOURTOKEN" \
  "http://localhost:1337/v1/posts/all?format=json"
```

## API Surface

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Returns service status, uptime, and timestamp. Useful for uptime monitors. |
| `GET` | `/v1/*` | Forwards requests to `https://api.pinboard.in` with the same path/query, after injecting auth info and normalizing responses. |
| `GET` | `/preview` | Fetches preview metadata (Twitter Card/Open Graph) for the supplied URL. Makes no Pinboard call. |
| `GET` | `/posts/suggest-with-preview` | Calls Pinboard’s `posts/suggest` and, in parallel, fetches preview metadata for the supplied URL. Answers once both are done; kept for older clients. |

Responses default to JSON. If Pinboard returns XML (the default), the bridge converts it to JSON via `fast-xml-parser` before sending the response back to the browser.

### `/preview`

Returns the `preview`, `previewStatus` and `previewError` fields described below, without the Pinboard suggestions. It takes the same `url` parameter and `Authorization` header as `/posts/suggest-with-preview`. Pinboard's `posts/suggest` can take 15 seconds or more for a URL it hasn't seen before, so clients that show a preview should call this and `/v1/posts/suggest` separately rather than wait on the combined route.

The bridge reads the page only as far as `</head>` (or 512 KB), and gives up on the whole fetch, redirects included, after 5 seconds.

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

- Preview fetches are limited to 30 requests per minute per Authorization token.
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
- 25-second budget for each Pinboard call, queueing included
- Sanitized error messages without leaking upstream responses
- Authorization headers only (tokens never logged in URLs)
- `Cache-Control: no-store` on every response, no ETags, so account data never lands in a browser cache

## Changelog

### Version 2.3.0
- Add `/preview`, which returns page metadata without waiting on Pinboard's `posts/suggest`
- Space Pinboard calls for the same user three seconds apart, per Pinboard's guidance (`PINBOARD_MIN_INTERVAL_MS`, `PINBOARD_MAX_QUEUE_MS`)
- Read preview pages only as far as `</head>`, under one 5-second deadline for the whole fetch
- Harden the preview fetcher's SSRF guard: refuse hostnames that resolve to private addresses, redirects to private hosts, and `0.0.0.0/8`, `100.64.0.0/10`, reserved, benchmarking and multicast IPv4, link-local, site-local and multicast IPv6, and IPv6 forms that embed an IPv4 address (mapped, compatible, NAT64, 6to4, Teredo)
- Hang up on a preview page once its head has been read, or as soon as it turns out to be an error or not HTML
- Key the `/preview` and `/posts/suggest-with-preview` rate limits on the client IP, since the `Authorization` header isn't checked there
- Only return http(s) links in previews; resolve relative links and take the site domain from the page actually fetched
- Log how long Pinboard and the preview fetch each took, with usernames stripped of characters that could forge log lines
- Drop a queued Pinboard call if the client has already disconnected (giving its slot to the next call), and cap queueing plus the Pinboard call at 25 seconds

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
