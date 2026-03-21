# Circe — Kate's Personal Assistant App

## About Kate (User Profile)

Kate is a special education teacher (grades 7–12) with early onset Alzheimer's. She is not a software developer and has minimal technical experience. Every feature must be designed with these constraints in mind:

**Accessibility requirements:**
- Minimum interaction: fewest clicks/steps possible to accomplish any task
- No technical jargon anywhere in the UI or in Circe's spoken responses
- Large, clear visual indicators of app state (the animated orb)
- All features must be operable by voice alone
- Error messages must be human-friendly ("Something went wrong, let's try again" not "HTTP 500")
- Follow WCAG 2.1 AA accessibility guidelines as a baseline
- Cognitive accessibility: simple language, consistent UI patterns, no surprises

**When implementing features:**
- Prefer one-click/one-voice-command over multi-step flows
- If setup is unavoidable, provide a friendly guided walkthrough (like setup-google.html)
- Never require Kate to edit files, run commands, or touch developer tools
- Default to "just works" — credentials persist, sessions restore, state is remembered

## What this is

A voice-activated web app named Circe. Activated by saying "Hey Circe". Always responds out loud via speech synthesis. Runs locally on Kate's computer (http://localhost:3000).

## Features

- Wake word detection ("Hey Circe")
- Task manager (priority/owner fields, voice set-priority), student tracker, daily schedule
- Google Calendar / Tasks / Gmail / Drive integration (browser-based GIS OAuth)
- **Multiple Google accounts** — work + personal, each with per-service defaults (calendar/tasks/email/drive); add/disconnect/toggle defaults from the sidebar; fully backwards-compatible with single-account
- Email body reading (`read_email` tool), web fetch + summarize (`web_fetch` tool with SSRF protection), Google Drive file search (`google_drive` tool)
- Two-model Claude setup: fast replies + expert consultant escalation
- Saves data to localStorage (local) and external services (when connected)

## Model setup

- Primary: `claude-sonnet-4-6` — fast, everyday replies
- Consultant: `claude-opus-4-6` — escalated when Circe says "my advisor"

## Credentials & persistence

- `ANTHROPIC_API_KEY` lives in `.env` (gitignored)
- Google Client ID lives in `.env` as `GOOGLE_CLIENT_ID` (gitignored)
- Settings UI saves to `config.json` (also gitignored), which takes priority over `.env`
- **Multi-account Google tokens:** account config (label, email, defaults) → `localStorage['circe_google_accounts']`; short-lived tokens → `sessionStorage['circe_token_<email>']`; legacy single-token key `google_token` is auto-migrated on first load

## Testing

**All new features must include unit tests.** No exceptions.

- Tests live in `tests/` and run with `npm test` (Jest)
- New server-side functions → test in `tests/localTools.test.js` or a new file
- New API endpoints → test in `tests/endpoints.test.js` (use supertest)
- New utility/encoding logic → test in a focused file like `tests/emailEncoding.test.js`
- Run `npm test` before committing — all tests must pass (currently 108)

## Architecture

- `server.js` — Express server, Claude API proxy, tool execution, OAuth routes
  - `runLocalTool(name, input, data)` — pure local tools (tasks, schedule, students); exported for testing
  - `runExternalTool(name, input, googleAccounts)` — Google/web tools; uses `getAccountToken` to pick the right token per service
  - `getAccountToken(accounts, service, preferredLabel)` — picks best token from multi-account array; exported for testing
  - `resolveAccounts(body)` — normalises `{googleAccounts:[…]}` and legacy `{googleToken:'…'}` into a unified array; exported for testing
  - `fetchExternalData(googleAccounts)` — fans out Google API calls across all connected accounts; labels results with `accountLabel`
- `config.js` — reads config.json then falls back to .env
- `integrations/google.js` — Google APIs using browser-issued GIS access token; includes `getEmailBody`, `getDriveFiles`
- `public/mergeUtils.js` — shared deduplication/merge logic (tasks, calendar, startup speech); also runs in Node for testing
- `public/index.html` — main UI
- `public/app.js` — frontend: voice, multi-account GIS sign-in, chat
  - `getAccountsPayload()` — builds token array for server API calls
  - `getToken(service, preferredLabel)` — client-side token picker
  - `handleTokenResponse(response, emailHint)` — processes GIS callback for any account
  - `promptAddAccount()` / `addGoogleAccount(label)` — adds a new Google account
  - `disconnectGoogleAccount(email)` — removes a single account
  - `setAccountDefault(email, service, isDefault)` — toggles per-service defaults
- `public/setup-google.html` — friendly Google Client ID setup guide

## Google API scopes required

`calendar`, `tasks`, `gmail.readonly`, `gmail.send`, `drive.readonly` — all requested in a single GIS consent. If a user connected before `drive.readonly` was added they need to Disconnect and reconnect to pick up the new scope.
