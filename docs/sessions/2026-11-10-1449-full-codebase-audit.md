# Session: Full codebase audit

**Date**: 2026-11-10
**Status**: Complete (draft PR open; nothing deployed)

## Overview

Ross asked for the same whole-project audit that Pincushion had earlier the same day (pincushion PR #86), now for the bridge: read everything, find what is broken, inconsistent, inefficient, dangerous, insecure, incomplete or no longer needed, fix what is certain, and list the rest for him to decide.

The bridge is small (one 1,180-line `web.js`, 13 test files) and had been through several review rounds in October, so most of what turned up was at the edges: dependency advisories, one path-handling hole in the `/v1/*` proxy, query-string mangling, mis-decoded non-UTF-8 pages, and documentation that had drifted from the code. Those are fixed here as version 2.3.1. Twenty-two further items that need a decision are listed under “For Ross to decide”.

No API contract changed. Pincushion (master and PR #86) calls `/v1/tags/get`, `/v1/posts/suggest`, `/v1/posts/add`, `/v1/posts/get` and `/preview` with `Authorization: Bearer user:token`; all of those behave as before, and the preview payload has the same fields.

## Goals

- [x] Read every file in the repository
- [x] Fix what is certain, each with a test
- [x] Keep the existing 115 tests passing (now 132)
- [x] List everything that needs a decision
- [x] Review per the project policy (see “Review”)

## Changes Made (the certain fixes)

| # | Kind | What was wrong | Fix |
|---|------|----------------|-----|
| 1 | Insecure | `npm audit` reported 3 high and 1 moderate advisory: follow-redirects (credentials following redirects), undici (several), qs | `npm audit fix`; axios 1.20.0 → 1.21.1, fast-xml-parser 5.11.2 → 5.12.0. `npm audit` is now clean |
| 2 | Dangerous | `/v1/*` forwarded the raw request path. `/v1/../x` and `/v1/%2e%2e/x` were resolved by the HTTP client to `https://api.pinboard.in/x`, so a request could leave `/v1/` on Pinboard's host (the host itself could not be changed) | `isPinboardV1Path` only accepts `/v1/` followed by plain segments (letters, digits, `_`, `-`) and answers 400 `Invalid API path` otherwise. No dots or percent-escapes means no dot segments in any spelling |
| 3 | Broken | Express's default query parser (qs) turned `a[b]=c` into a nested object, which was forwarded to Pinboard as `a=[object Object]` | `app.set('query parser', 'simple')`: keys are forwarded as sent. Repeated keys (`tag=x&tag=y`) still work. `auth_token[]`, `auth.token` and similar spellings are now stripped along with `auth_token` (`isAuthTokenKey`) |
| 4 | Broken | Preview pages were always decoded as UTF-8, so Shift_JIS, GBK, windows-1252 and similar pages gave garbled titles | `decodeHead` reads valid UTF-8 as UTF-8 whatever is declared; only for other bytes does it follow the `Content-Type` charset, then a parsed `<meta charset>`/`http-equiv` tag. Uses Node's built-in `TextDecoder` (full ICU), no new dependency |
| 5 | Insecure (minor) | `siteHandleUrl` was built from whatever text the page put in `twitter:site`, so `../../i/flow/login` or `a?b=c` produced a link to somewhere else on twitter.com | Only built when the text matches `[A-Za-z0-9_]{1,15}`. `siteHandle` itself is unchanged |
| 6 | Inconsistent | Pinboard call spacing was keyed on a hash of the raw `Authorization` header, so `Basic …`, `Bearer …` and `bearer   …` for the same user each got their own queue | Keyed on the decoded `username:token` |
| 7 | Inconsistent | `/posts/suggest-with-preview` sent the raw network error text (`connect ECONNREFUSED 1.2.3.4:443`) as `suggestionsError`, while preview errors were already reported by kind only | Reports `Pinboard API is unreachable` or `Pinboard suggest failed`; the raw text stays in the log |
| 8 | Broken | The README says `cp .env.example .env`, but nothing read `.env` | `npm run dev` now runs `node --env-file-if-exists=.env web.js`. `npm start` and the Procfile are unchanged |
| 9 | No longer needed | `app.options('*', cors(…))` duplicated what `app.use(cors(…))` already does; `pickMetaValueWithSource` existed for a check that was always true | Removed both |
| 10 | Inconsistent | `"private": "true"` was a string | Now the boolean `true` |
| 10a | Inconsistent | `.env.example` set `NODE_ENV=production` and allowed only the GitHub Pages origin, which fix 8 would have turned into a CORS-locked dev server | `NODE_ENV=development`, and `http://localhost:3000` added to the sample origins (matching what Heroku has) |
| 11 | Insecure (minor) | The CI workflow ran with the default token permissions | `permissions: contents: read` |
| 12 | Inconsistent | The `/v1/` path went into a log line unfiltered | The path allow-list in fix 2 leaves only safe characters; the label is also cut to 64 characters |
| 13 | Inconsistent docs | README said `git push heroku main` (the branch is `master`), a 30-second timeout (it is 25), “per-token preview throttling” (it is per IP), “no request logging” (it logs a line per Pinboard call and preview), and “without leaking upstream responses” (a Pinboard error body is passed back on `/v1/*`) | Corrected; changelog entry for 2.3.1 added |

### New files

- `test/audit-fixes.test.js`: path guard, query forwarding, `decodeHead`, `siteHandleUrl`, sanitised `suggestionsError`
- `test/pinboard-slot-key.test.js`: Basic and Bearer forms of one credential share a queue; a different token does not
- `docs/sessions/2026-11-10-1449-full-codebase-audit.md`: this file

## For Ross to decide

Nothing below was changed. Each has my recommendation.

### Security

1. **`/preview` is an open page-head fetcher.** It only checks that an `Authorization` header is well formed, and requests with no `Origin` header skip the CORS allow-list entirely, so anyone with curl can use it (60 a minute per IP). This is documented, and the private-address guard holds, but it is the bridge's largest abuse surface. Options: validate the credential against Pinboard once and cache the verdict for a few minutes; or accept it. *Recommend: validate and cache.*
2. **Preview fetches may go to any port.** `http://public-host:6379/` is allowed, so the bridge can be used to probe ports on public hosts. *Recommend: allow only 80, 443, 8080 and 8443, or default ports only.*
3. **URLs with embedded credentials (`https://user:pass@host/`) are accepted** by both preview routes, sent to the page as Basic auth, and passed on to Pinboard. *Recommend: refuse them with a 400.*
4. **CORS is not access control, and fails open.** With `ALLOWED_ORIGINS` unset every origin is allowed, even with `NODE_ENV=production`. Heroku has it set, so this only bites a fresh deployment. *Recommend: refuse to start in production without it, or at least log a warning at error level.*
5. **`credentials: true` in the CORS options** sends `Access-Control-Allow-Credentials: true`. The bridge uses no cookies and Pincushion does not set `withCredentials`, so it does nothing useful. *Recommend: remove.* Likewise the allowed headers `X-Requested-With`, `X-HTTP-Method-Override` and `Origin` are not needed.
6. **The per-IP limiter counts a whole IPv6 address**, so a client with a /64 can rotate addresses. express-rate-limit 8 groups IPv6 by /56. That is a major version (see 18).
7. **Logs hold each user's bookmarked hostnames.** Every preview logs `user=… host=…`. Useful for spotting misuse, but it is a browsing record in Heroku's log stream. *Recommend: keep, but decide knowingly; dropping `host=` is a one-line change.*
8. **CI's `npm audit` step is `continue-on-error`**, which is how four advisories sat unnoticed. *Recommend: make it blocking at `--audit-level=high`; Dependabot already opens the fix PRs.*

### Behaviour

9. **Pinboard responses are buffered whole, with no size cap.** `/v1/posts/all` on a large account is tens or hundreds of megabytes held in memory, parsed and re-serialised on a 512 MB dyno. *Recommend: cap the response (say 50 MB, answering 502 beyond it), or stream JSON straight through when `format=json`.*
10. **A Pinboard error body is passed back verbatim** as `{ "error": "<body>" }` on `/v1/*`, which can be a whole HTML error page. *Recommend: pass the status, and a short fixed message unless the body is short plain text.*
11. **With `format=json`, a non-JSON 200 from Pinboard** (it sometimes sends an empty or plain-text body) is returned as a JSON string rather than an error. Pincushion then reads `result_code` as undefined. *Recommend: answer 502 `Unexpected response from Pinboard`.*
12. **Pinboard redirects are followed** (axios's default of five). Pinboard's API has no reason to redirect, and with Bearer auth the token is in the URL. *Recommend: `maxRedirects: 0` on Pinboard calls.*
13. **Only GET is proxied**, so a long `posts/add` (notes up to 65,536 characters) depends on URL length limits; Pincushion already handles a 414. Pinboard accepts POST. A POST route would be a new feature on both sides.
14. **Server keep-alive is Node's default 5 seconds.** Heroku's newer router (Router 2.0) keeps idle connections to the dyno for up to 90 seconds, and the mismatch can produce occasional H13 or 503 errors. *Speculative: I could not see which router the app uses. If it is Router 2.0, set `server.keepAliveTimeout` to about 95 seconds.*
15. **No handlers for `unhandledRejection` or `uncaughtException`.** Node's default is to crash, and Heroku restarts the dyno, which is a reasonable policy; say if you would rather log and carry on.
16. **Preview text has no length cap.** A title or description can be as long as the 512 KB head. *Recommend: trim to a few hundred characters.*
17. **`meta` tags written as `name="og:title"`** (common, though wrong) are not read, and an empty first `<meta>` hides a filled-in later one. Small gaps in preview coverage.

### Clean-up

18. **Major upgrades available:** Express 4.22 → 5.3 and express-rate-limit 7.5 → 8.7. Both need care (Express 5 changes the `/v1/*` route syntax and the query parser). *Recommend: a separate PR.*
19. **`/posts/suggest-with-preview` is no longer called by Pincushion** (2.4 uses `/preview` and `/v1/posts/suggest`). It is about 90 lines of route and a 489-line test file. *Recommend: remove it in the next minor version once you are sure no old bookmarklet depends on it.*
20. **`heroku.yml` appears unused.** Heroku only reads it on the `container` stack; this app runs the Node buildpack on `heroku-26`, and `app.json` already declares the stack. *Recommend: delete, after a look at the app's stack setting.*
21. **The User-Agent says `pinboard-bridge/2.0`** while the package is 2.3.1. An October review deliberately froze it rather than tie it to `package.json`. *Recommend: leave, or change it to `pinboard-bridge/2`.*
22. **CI runs twice on PR branches** (`push` on every branch, plus `pull_request`). *Recommend: limit `push` to `master`.* There is also no linter and no licence file.

## Key Decisions

### Guard the path by its characters, not by a list of endpoints

The first version resolved the URL the way axios does and checked it was still under `/v1/`. Review showed that only mirrors the client: `/v1/..%2f..%2fx` passes, and Pinboard's own server might decode and resolve it. The guard is now a character allow-list (`/v1/` plus segments of letters, digits, `_` and `-`). Every Pinboard API method fits it, nothing with a dot or a percent-escape does, and what is checked is exactly what is sent and logged. A list of named endpoints would be tighter still but would need maintaining.

### UTF-8 first when decoding pages

The first version trusted the declared charset. Review pointed out that plenty of UTF-8 pages sit behind a server with a wrong default `charset=ISO-8859-1` header, and those decoded correctly before. Bytes that are valid UTF-8 are almost never anything else, so validity is checked first and the declaration only matters for pages that fail it. The `<meta>` tag is found with cheerio rather than a regular expression, which was both wrong (it matched comments and other attributes) and quadratic on hostile input.

### The simple query parser

The alternative was to flatten qs's nested objects back into bracketed keys. Not parsing them in the first place is shorter and exact. Pinboard's API uses no bracketed keys, so nothing that worked before changes.

### Left the legacy route in place

`/posts/suggest-with-preview` is probably dead, but removing an endpoint is a contract change, so it is item 19 rather than a fix.

## Review

The multi-LLM review skill is only on Ross's Mac, so per the project policy this used the fallback: `/code-review` at high effort, twice. Findings and what was done with them are under “Review results” at the end of this file.

## Lessons Learned

1. **`fetch()` and `new URL()` tidy dot segments away**, so a test for `/v1/../x` has to send the path with `http.request`, and the upstream URL has to be compared as a raw string.
5. **A backtracking regular expression over page bytes is a denial-of-service risk.** `<meta\b[^>]*?\bcharset` took 11.5 seconds on 512 KB of `<meta ` and blocked the event loop past the 5-second preview deadline. Parse instead.
6. **Changing the query parser changes what every later key check sees.** With qs, `auth_token[]` was folded into `auth_token` and stripped; with the simple parser it is a different key.
2. **`npm audit fix` needs `npx -y npm@11`** in the cloud container; npm 10.9.9 is what is installed, and the package's `engines` asks for 11.
3. **One test failed once on the very first run after `npm ci` and never again** in ten further runs, four of them in parallel. I did not capture which. Worth watching CI for a timing-sensitive test.
4. **Node's `TextDecoder` covers the legacy encodings** (Shift_JIS, GBK, windows-125x) on any full-ICU build, which Node 24 is, so charset support needs no dependency.

## Next Steps

- [ ] Ross: review and merge the PR, then deploy with `git push heroku master` from the Mac (2.3.1)
- [ ] Ross: decide the 22 items above

## Review results

### First `/code-review high` pass: 10 findings, all in this session's own changes, all fixed

1. The `<meta charset>` regular expression was quadratic (11.5 s on a hostile 512 KB head). Replaced by a cheerio lookup; a timing test covers it.
2. The same expression matched `charset=` inside comments and other attributes, mis-decoding good UTF-8 pages. Fixed by 1 and by checking UTF-8 validity first.
3. The path guard let `/v1/..%2f..%2fx` through. Replaced by the character allow-list.
4. `auth_token[]=…` slipped past the `auth_token` strip under the simple query parser. All spellings are now stripped.
5. A wrong `charset=ISO-8859-1` header garbled UTF-8 pages that decoded correctly before. Valid UTF-8 now wins.
6. `npm run dev` plus the sample `.env` gave a CORS-locked production-mode server. `.env.example` made dev-friendly.
7. The guard checked one parse of the path while the handler sent and logged the raw string. With the allow-list they are the same string.
8. A test claimed to prove the HTTP client's behaviour but re-parsed the URL itself. Rewritten to compare the raw string.
9. This file pointed at a review section that did not exist. It does now.
10. The README still promised `siteHandleUrl` for every Twitter tag. Corrected.
