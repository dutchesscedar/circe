# Circe — Feature Backlog

**How this file works:**
Claude reads this file and considers outstanding requests when answering current ones — to avoid painting ourselves into design corners. Features are categorized by feasibility. Claude keeps this file up to date as work is completed or scoped.

---

## ✅ Completed Features

| Feature | Notes |
|---|---|
| Wake word detection ("Hey Circe") | Phonetic variants supported |
| Voice synthesis (TTS) | Moira/Enhanced voice preferred; watchdog for browser TTS blocking |
| Speech recognition (continuous) | Auto-restarts; wake word + chat mode flows |
| Chat mode | Button toggle + voice commands ("start chat mode", "end chat mode", "stop listening"); pulsing dot indicator |
| Two-model Claude setup | Sonnet for fast replies; Opus escalation via "my advisor" |
| Task manager | Create, complete, delete, list — voice + text |
| Daily schedule | Add events by date/time via voice |
| Google Calendar integration | OAuth via GIS; auto-refresh token; silent validation on load |
| Google Tasks integration | Read, create, complete |
| Gmail read + send | Via Google OAuth |
| Sidebar (tasks + calendar widget) | Live refresh after each turn; merges Google + local data |
| Startup verbal greeting | Reads pending tasks + today's events aloud on load |
| Deduplication (tasks + calendar) | Merges local and Google copies without showing duplicates |
| Compact top-bar UI | 56px orb upper-left; status text; Chat Mode button |
| Autoscroll conversation | Uses requestAnimationFrame + scrollIntoView |
| Interrupt current speech | New command cancels TTS immediately |
| Student notes tracker | Add/retrieve notes per student by name |
| Prioritized to-do list | `priority` (high/medium/low) + `owner` fields on tasks; sidebar sorts by priority with color badges; `set_priority` voice command |
| Email body reading | `read_email` tool reads full email content by ID via Gmail API |
| Scan & summarize (web) | `web_fetch` tool fetches any URL server-side, strips HTML, caps at 8KB; SSRF protection built in |
| Google Drive file search | `google_drive` tool lists recent files or searches by keyword via Drive v3 API |
| Multiple Google Accounts | Work + personal (or any labels); per-service defaults (cal/tasks/email/drive); sidebar cards with toggle pills; add/disconnect per account; auto-migrates legacy single-token; backwards compatible |

---

## 🟢 Ready to Build — Feasible Within Current Architecture

These fit naturally into Circe's existing browser + Claude + Google APIs stack.

### ✅ Prioritized To-Do List — DONE
Priority (high/medium/low) and owner fields now on all tasks. Sidebar sorts by priority with color badges. Say "set this to high priority" or include priority when adding tasks.

### Email Management (Expand Gmail)
- Categorize inbox by subject/sender automatically
- Flag and surface important emails verbally ("You have 3 unread messages, one looks urgent")
- Summarize email threads on request
- Read full email body ✅ done via `read_email` tool
- **Design note:** Categorization/flagging needs a Claude-powered layer on top of `getRecentEmails`

### ✅ Scan & Summarize (Web) — DONE
`web_fetch` tool: paste or say a URL and Circe will fetch, strip, and summarize. SSRF protection built in. Browser extension not needed.
- Highlight text and have Circe explain or revise it — still needs browser extension approach

### ✅ Google Drive Access — DONE
`google_drive` tool: list recent files or search by keyword. Returns file names + direct links. Requires `drive.readonly` OAuth scope (re-auth needed if previously connected).

### ✅ Barge-in support — DONE
Voice interruption now works in both modes:
- **Chat mode:** any spoken utterance (after a 600ms grace period) cancels TTS and processes the command
- **Outside chat mode:** saying "Hey Circe" while Circe is speaking cancels TTS and activates listening
- Grace period prevents Circe's own voice from triggering self-interruption

### Customizable Dashboard / Navigation
- Rearrange sidebar panels
- Choose which widgets appear
- Saved layout in config.json
- **Design note:** CSS grid re-ordering + settings UI; moderate effort

### Bookmarks & Browser History Summary
- "What sites do I visit most?" → voice-summarized answer
- Save bookmarks by voice: "Circe, bookmark this"
- **Design note:** Requires browser extension to read history/bookmarks (Chrome extension API) OR manual URL input

---

## 🟡 Significant Effort — Needs Planning Before Starting

These are feasible but require a meaningful architecture expansion.

### Cross-Calendar Sync (non-Google)
- Connect phone calendar, watch (via iCloud), Alexa, Siri
- Unified view across all platforms
- **Design note:** iCloud Calendar has no public API; Alexa/Siri require their own integrations. Google Calendar is done. This would mean Apple CalDAV or a third-party sync service like Zapier.

### Owner-Assigned Tasks with Notifications
- Assign tasks to other people; track whether they're done
- **Design note:** Needs a shared backend or email/SMS integration; not just localStorage

---

## 🔴 Requires Radical Redesign — Do Not Start Without Planning Session

These features require **OS-level computer control** — the ability to click, type, open apps, and manipulate the desktop. A browser tab cannot do this. To support these, Circe would need to be rebuilt as an **Electron desktop app** or use a **computer-use agent** (e.g. Claude's Computer Use API).

Flag these as "Phase 2 — Desktop Agent" before any work begins.

### Voice Command Task Execution (in-document editing)
- "Circe, dictate" / "Make bold" / "Change font" / "Indent" / "Bullets" / "Find and replace" / "Suggest revisions"
- **Why blocked:** Requires programmatic control of Word, Google Docs, etc. Not accessible from a browser sandbox.
- **Path forward:** Electron app + OS accessibility APIs, or Claude Computer Use API

### Open Programs, Websites, Documents by Voice
- "Open Chrome" / "Open Word" / "Open my lesson plan"
- **Why blocked:** Browser cannot launch other applications.
- **Path forward:** Electron app with Node.js `child_process`, or AppleScript bridge

### Navigation Between Programs/Tabs/Windows
- Switch apps, tabs, browser windows by voice
- **Why blocked:** Cross-app navigation requires OS-level focus control.
- **Path forward:** AppleScript (macOS) or Electron; Chrome tab control possible via Chrome extension

### Bluetooth Device Control
- Connect/disconnect Promethean board, speakers, headphones by voice
- **Why blocked:** Web Bluetooth API exists but is extremely limited; full pairing/control requires OS APIs.
- **Path forward:** Electron + Node.js bluetooth library

### Mouse / Screen Share / Screen Takeover
- "Circe, take over my screen" / "Move the mouse to X"
- **Why blocked:** Completely outside browser sandbox.
- **Path forward:** Claude Computer Use API (most viable), or Electron + robotjs

### System Settings Access
- Adjust volume, display brightness, accessibility settings by voice
- **Why blocked:** No browser access to OS settings.
- **Path forward:** Electron + Node.js OS APIs or AppleScript

---

## 💡 Design Principles to Keep in Mind

When building new features, protect against these future needs:

1. **Task schema is extensible** — always include `id`, `title`, `done`, `googleId`, `source`; adding `priority`, `owner`, `dueDate` should be non-breaking
2. **Google OAuth scopes** — add new Drive/Calendar scopes before users need them; scope changes require re-auth
3. **Tool architecture** — server.js `runLocalTool` is the right place for new local data tools; keep side-effect tools (Google, email) in `integrations/google.js`
4. **If a feature needs a browser extension** — design it as optional; Circe must still work without it
5. **If a feature needs OS access** — that's Phase 2 (Desktop Agent); don't hack around the browser sandbox
