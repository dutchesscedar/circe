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
- Task manager, student tracker, daily schedule
- Google Calendar / Tasks / Gmail integration (browser-based GIS OAuth)
- Microsoft Outlook Calendar / To Do / Mail integration (server-side OAuth)
- Two-model Claude setup: fast replies + expert consultant escalation
- Saves data to localStorage (local) and external services (when connected)

## Model setup

- Primary: `claude-sonnet-4-6` — fast, everyday replies
- Consultant: `claude-opus-4-6` — escalated when Circe says "my advisor"

## Credentials & persistence

- `ANTHROPIC_API_KEY` lives in `.env` (gitignored)
- Google Client ID lives in `.env` as `GOOGLE_CLIENT_ID` (gitignored)
- Microsoft credentials live in `.env` as `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` (gitignored)
- Settings UI saves to `config.json` (also gitignored), which takes priority over `.env`
- Google access token is short-lived (1 hr), stored in sessionStorage, refreshed via GIS

## Architecture

- `server.js` — Express server, Claude API proxy, tool execution, OAuth routes
- `config.js` — reads config.json then falls back to .env
- `integrations/google.js` — Google APIs using browser-issued GIS access token
- `integrations/microsoft.js` — Microsoft Graph API via MSAL (server-side)
- `public/index.html` — main UI
- `public/app.js` — frontend: voice, GIS sign-in, chat
- `public/setup-google.html` — friendly Google Client ID setup guide
