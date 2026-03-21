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
| Barge-in (voice interrupt) | Mic stays live during TTS; chat mode: any speech interrupts; outside chat mode: wake word interrupts; 600ms grace period prevents self-interruption |

---

## 🟢 Ready to Build — Feasible Within Current Architecture

These fit naturally into Circe's existing browser + Claude + Google APIs stack.

### ✅ Email Management — Urgent Flagging DONE
- Read full email body ✅ done via `read_email` tool
- ✅ Urgent emails flagged in system prompt (subject keywords: urgent, deadline, ASAP, etc.); Circe proactively mentions them
- Categorize full inbox by subject/sender automatically — still pending
- Summarize email threads on request — still pending (chains multiple `read_email` calls)

### ✅ Task Completion Reports — DONE
- `completedAt` timestamp and optional `summary` field added to task schema
- `list_completed` action added — say "what did I finish this week?" to review
- Circe generates a brief summary note at completion time
- Recently completed tasks shown in Claude's context so it remembers what was done

### ✅ Smart Suggestions / Simplify Workflows — DONE
Baked into system prompt: Circe proactively offers one-sentence simplification tips after completing requests.

### ✅ Natural Language Command Vocabulary — DONE
"What can you do?" (and "help", "how do you work") triggers a client-side spoken cheat-sheet of commands. No server round-trip needed.

### Deadline Reminders & Time Estimates
- Proactive reminders of upcoming deadlines (verbal + sidebar)
- Give time-to-complete estimates when creating or viewing tasks
- Track how long tasks actually take to help adjust future estimates
- **Design note:** Needs `dueDate` and `estimatedMinutes` fields on tasks; a polling/check loop to surface reminders; historical duration tracking to improve estimates over time

### In-Progress Task Tracking
- Show in-progress tasks with % done and next steps
- Project trackers for multi-step tasks that break down all the steps needed
- Connected to the prioritized to-do list
- **Design note:** Extend task schema with `status` (not-started / in-progress / done), `percentComplete`, `subtasks[]` array, and `nextStep`; sidebar groups tasks by status

### Aggregated Prioritized To-Do List
- Build a unified priority list from emails, calendar, voice commands, and student caseload
- Circe synthesizes across data sources to surface what matters most
- **Design note:** Claude-powered aggregation layer — on session start or on demand, pull recent emails + calendar events + existing tasks, then rank and merge into one list

### Smart Suggestions / Simplify Workflows
- Circe proactively offers suggestions to make things easier or simplify a workflow
- Balance of complete "rightness" and simplicity — don't over-engineer Kate's requests
- **Design note:** Behavioral/prompt-engineering feature — bake into system prompt and tool-selection logic so Claude looks for opportunities to streamline rather than just executing literally

### Natural Language Command Vocabulary
Circe should recognize and respond consistently to a standard set of commands:
- **"Read this"** — read aloud the current content
- **"Summarize"** — summarize a thread, page, or content
- **"Remind"** — set a reminder for a specific time or event
- **"Prioritize"** — re-rank tasks by importance
- **"Explain"** — explain a concept or passage in plain language
- **"Consult"** — escalate to the Opus advisor for deeper analysis
- **"What can you do?"** — spoken help/cheat-sheet of available commands
- **Design note:** Many of these already work implicitly through Claude's tool routing. This feature is about making the vocabulary explicit and adding a discoverable "what can you do?" help command

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
- **Jasper's question — what if Google Docs is open in the browser?** Still blocked unfortunately. Even if Google Docs is in another tab, Circe's tab cannot read or write to a different tab's DOM — browsers isolate tabs for security. The only path is a Chrome extension (which CAN inject into any tab). That's a separate build but not as big as Electron. Flag for future planning.
- **Path forward (near-term):** Chrome extension that injects a listener into Google Docs tabs — feasible, design needed. Electron + OS accessibility APIs also works for desktop Word.

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

1. **Task schema is extensible** — always include `id`, `title`, `done`, `googleId`, `source`; adding `priority`, `owner`, `dueDate`, `completedAt`, `subtasks` should be non-breaking
2. **Google OAuth scopes** — add new Drive/Calendar scopes before users need them; scope changes require re-auth
3. **Tool architecture** — server.js `runLocalTool` is the right place for new local data tools; keep side-effect tools (Google, email) in `integrations/google.js`
4. **If a feature needs a browser extension** — design it as optional; Circe must still work without it
5. **If a feature needs OS access** — that's Phase 2 (Desktop Agent); don't hack around the browser sandbox
