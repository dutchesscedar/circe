# Circe — Personal Voice Assistant

A voice-first personal assistant built for **Kate**, a special education teacher (grades 7–12) with early onset Alzheimer's. Circe runs locally in a browser, responds out loud, and connects to Google to keep tasks, calendar, email, and files in sync.

Say **"Hey Circe"** to wake her up. Everything else is voice.

---

## ✨ What Circe Can Do

### Voice & Conversation
- Wake on "Hey Circe" (with phonetic fallbacks: "Surce", "Searcy", etc.)
- Natural TTS voice (Moira / Enhanced when available)
- **Chat mode** — stays listening after each response for back-and-forth conversation
- Escalates hard questions to a more powerful AI advisor automatically

### Task Management
- Add, complete, and delete tasks by voice
- **Priority levels** (high / medium / low) with color-coded sidebar badges
- Assign tasks to an owner; say "set this to high priority" at any time
- Syncs with Google Tasks; deduplicates local + Google copies

### Calendar & Schedule
- Add events by voice ("add team meeting Tuesday at 2pm")
- Pulls from **Google Calendar** — shows upcoming events in the sidebar
- Startup greeting reads today's events and pending tasks aloud

### Email (Gmail)
- Hear your recent emails summarized on request
- Read a full email by voice: "read that email from Dr. Smith"
- Send emails by voice: "send an email to the principal about Thursday's meeting"

### Google Drive
- Search your Drive by keyword: "find my lesson plan for March"
- Returns file names and direct links

### Web Research
- Paste or say any URL — Circe fetches and summarizes the page
- Built-in SSRF protection so only public URLs are allowed

### Student Notes
- Add notes per student by name: "add a note for Alex — needs extra time on tests"
- Retrieve notes on request: "what do I have for Jordan?"

### Multiple Google Accounts
- Connect work **and** personal Google accounts simultaneously
- Set defaults per service (calendar, tasks, email, Drive) independently
- Say "use my work email" or "add to my personal calendar" and Circe routes correctly
- Add / disconnect accounts and toggle defaults right from the sidebar

---

## 🏗️ Architecture

```
circe/
├── server.js               # Express server, Claude API proxy, tool execution
├── config.js               # Reads config.json → falls back to .env
├── integrations/
│   └── google.js           # Google Calendar, Tasks, Gmail, Drive API calls
├── public/
│   ├── index.html          # Main UI
│   ├── app.js              # Frontend: voice recognition, GIS OAuth, chat
│   ├── mergeUtils.js       # Task/calendar deduplication (shared browser + Node)
│   └── setup-google.html   # Guided Google Client ID setup walkthrough
└── tests/                  # Jest unit tests (108 passing)
```

**AI models**
| Role | Model |
|---|---|
| Primary (everyday) | `claude-sonnet-4-6` |
| Advisor (escalated) | `claude-opus-4-6` |

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- An [Anthropic API key](https://console.anthropic.com/)
- A Google Cloud project with OAuth 2.0 credentials (see in-app setup guide)

### Install & run

```bash
git clone https://github.com/dutchesscedar/circe.git
cd circe
npm install
```

Create a `.env` file:
```
ANTHROPIC_API_KEY=your_key_here
GOOGLE_CLIENT_ID=your_google_client_id   # optional — can be set via the in-app UI
```

```bash
npm start
# Open http://localhost:3000
```

### Google setup
Visit `http://localhost:3000/setup-google.html` for a step-by-step walkthrough. No command line needed.

---

## ✅ Completed Features

| Feature | Notes |
|---|---|
| Wake word detection | "Hey Circe" + phonetic variants |
| Voice synthesis | Moira/Enhanced preferred; watchdog prevents silent failures |
| Continuous speech recognition | Auto-restarts; wake word + chat mode flows |
| Chat mode | Voice toggle + pulsing dot indicator |
| Two-model Claude setup | Sonnet for speed; Opus escalation via "my advisor" |
| Task manager | Create, complete, delete, list — fully by voice |
| Priority + owner on tasks | high/medium/low badges; `set_priority` voice command |
| Daily schedule | Add events by date/time via voice |
| Google Calendar | OAuth via GIS; auto-refresh; silent validation on load |
| Google Tasks | Read, create, complete |
| Gmail read + send | Full email body reading; compose and send by voice |
| Google Drive search | List recent files or search by keyword |
| Multiple Google accounts | Per-service defaults; sidebar cards; add/disconnect per account |
| Sidebar | Live tasks + calendar; refreshes after every turn |
| Startup greeting | Reads pending tasks + today's events aloud |
| Deduplication | Merges local and Google copies cleanly |
| Compact UI | 56px orb; status text; Chat Mode button |
| Autoscroll | Smooth scroll to latest message |
| Interrupt speech | New command cancels current TTS immediately |
| Student notes tracker | Per-student notes by name |
| Web fetch + summarize | Paste or say any public URL; SSRF-protected |

---

## 🗺️ What's Next

### Ready to build (no new APIs needed)
- Customizable sidebar layout (drag panels, show/hide widgets)
- Email inbox categorization and urgent-email alerts
- Bookmark pages by voice (needs browser extension or manual URL)

### Significant effort
- Cross-platform calendar sync (iCloud, Alexa, Siri) — no public iCloud API exists yet
- Owner-assigned tasks with notifications — needs a shared backend

### Phase 2 — Desktop Agent only
These require OS-level control (Electron app or Claude Computer Use API) and are **not** attempted in the current browser-based architecture:
- In-document editing (Word, Google Docs)
- Open apps or websites by voice
- Bluetooth device control
- Screen share / screen takeover

---

## 🧪 Tests

```bash
npm test   # Runs all 108 Jest tests
```

All new features ship with unit tests before commit. No exceptions.

---

## 📁 Data & Privacy

- All personal data stays on Kate's local machine (`localStorage` / `sessionStorage`)
- Google tokens are short-lived (1 hr) and refreshed automatically; never stored in files
- The Anthropic API key lives in `.env` (gitignored)
- No external database; no accounts required beyond Google and Anthropic

---

*Built with care for Kate.*
