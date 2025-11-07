# Pinboard Bridge

A CORS-enabled proxy service for the Pinboard API with enhanced security features.

## Features

- **CORS Support**: Configurable cross-origin resource sharing
- **Security Headers**: Helmet.js integration for secure HTTP headers
- **Rate Limiting**: 100 requests per 15 minutes per IP address
- **Request Logging**: Morgan HTTP request logger
- **XML to JSON Conversion**: Automatic XML response conversion using fast-xml-parser
- **Health Check Endpoint**: Monitor service status at `/health`
- **Graceful Shutdown**: Proper handling of SIGTERM/SIGINT signals
- **Error Handling**: Comprehensive error handling with consistent JSON responses

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | 1337 | No |
| `NODE_ENV` | Environment mode | development | No |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins | (all origins) | No |

### Example Configuration

For production, set `ALLOWED_ORIGINS` to restrict which domains can access your API:

```bash
ALLOWED_ORIGINS=https://example.com,https://app.example.com
```

## API Usage

### Authentication

The bridge supports both old and new Pinboard authentication methods:

- **Basic Auth**: Send `Authorization: Basic <base64(username:password)>` header
- **Token Auth**: Include `auth_token` in query parameters

### Endpoints

- `GET /health` - Health check endpoint
- `GET /v1/*` - Proxy to Pinboard API (e.g., `/v1/posts/all`)

### Rate Limits

- 100 requests per 15 minutes per IP address
- Rate limit info returned in `RateLimit-*` headers

## Deployment

### Heroku

This project is configured for Heroku deployment on the `heroku-24` stack.

```bash
git push heroku main
```

## Security Features

- Helmet.js security headers
- CORS origin validation
- Rate limiting per IP
- 30-second request timeout
- Sanitized error messages
- No sensitive data exposure

## Changelog

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
