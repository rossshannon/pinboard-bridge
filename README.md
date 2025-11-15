# Pinboard Bridge

A CORS-enabled proxy service for the Pinboard API with enhanced security features.

## Features

- **CORS Support**: Configurable cross-origin resource sharing with JSON error responses
- **Security Headers**: Helmet.js integration for secure HTTP headers
- **Rate Limiting**: 100 requests per 15 minutes per IP address
- **Header-based Authentication**: Keeps Pinboard credentials out of URLs
- **XML to JSON Conversion**: Automatic XML response conversion using fast-xml-parser
- **Health Check Endpoint**: Monitor service status at `/health`
- **Graceful Shutdown**: Proper handling of SIGTERM/SIGINT signals
- **Error Handling**: Comprehensive error handling with consistent JSON responses

## Requirements

- Node.js 18+ (matches the Heroku-24 build image)
- npm 8+
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

- 100 requests per 15 minutes are allowed per source IP. Heroku users should ensure `app.set('trust proxy', 1)` remains enabled so the limiter sees client IPs.
- When throttled, responses include standard `RateLimit-*` headers so the UI can surface “retry-after” information.

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

Responses default to JSON. If Pinboard returns XML (the default), the bridge converts it to JSON via `fast-xml-parser` before sending the response back to the browser.

## Deployment

### Heroku (recommended)

1. Provision an app on the `heroku-24` stack.
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
- Rate limiting per IP
- 30-second request timeout
- Sanitized error messages without leaking upstream responses
- Authorization headers only (tokens never logged in URLs)

## Changelog

### Version 2.0.0
- Require Authorization headers and ignore inbound `auth_token` query parameters
- Support `Authorization: Bearer username:token` so clients can keep tokens out of URLs while Pinboard still receives `auth_token`
- Remove request logging to prevent credential exposure in logs
- Return JSON 403 responses for blocked origins
- Document recommended `ALLOWED_ORIGINS` value (`https://rossshannon.github.com`) and update `.env.example`
- Bump dependencies to drop unused logging package

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
