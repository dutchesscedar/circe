// ── Circe Voice App ──────────────────────────────────────────────────────────

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

class CirceApp {
  constructor() {
    this.state = 'standby';        // standby | listening | processing | speaking
    this.recognition = null;
    this.conversation = [];        // sent to server each turn
    this.data = this.loadData();
    this.useConsultant = false;

    // Multi-account Google support
    this.clientId = null;
    this.googleAccounts = this.loadGoogleAccounts(); // [{label, email, token, defaults}]
    this.tokenClients = {};     // keyed by email (or '_' for unknown/legacy)
    this.refreshTimers = {};    // keyed by email (or '_')
    this.pendingAccountLabel = null; // label for the account being added

    this.calendarData = [];    // latest calendar events from server
    this.conversationMode = false; // when on, Circe re-listens after each response
    this.pendingCompletions = []; // options shown to Duchess; next number/word selects one
    this.ttsVoice = 'Samantha';   // macOS say voice; loaded from settings on init
    this._useMacOSTTS = false;    // set to true once loadTTSVoice() confirms server is up
    this._currentTTSAudio = null; // current HTMLAudioElement playing macOS TTS

    this.statusEl = document.getElementById('status-text');
    this.interimEl = document.getElementById('interim-text');
    this.convEl = document.getElementById('conversation');
    this.taskListEl = document.getElementById('task-list');

    this.updateTaskDisplay();
    this.updateCalendarDisplay();
    this.initGoogle();      // sets up GIS, then loads connection status
    this.loadTTSVoice();    // read saved voice preference from server settings

    if (!SpeechRecognition) {
      document.getElementById('error-banner').style.display = 'block';
      this.setState('standby', 'Type a message below to chat');
      return;
    }

    this.setupRecognition();
    this.recognition.start();
    this.greet();
  }

  // ── Data persistence ────────────────────────────────────────────────────────

  loadData() {
    return {
      tasks:    JSON.parse(localStorage.getItem('circe_tasks')    || '[]'),
      students: JSON.parse(localStorage.getItem('circe_students') || '{}'),
      schedule: JSON.parse(localStorage.getItem('circe_schedule') || '[]'),
    };
  }

  saveData(incoming) {
    if (incoming.tasks != null) {
      localStorage.setItem('circe_tasks', JSON.stringify(incoming.tasks));
      this.data.tasks = incoming.tasks;
    }
    if (incoming.students != null) {
      localStorage.setItem('circe_students', JSON.stringify(incoming.students));
      this.data.students = incoming.students;
    }
    if (incoming.schedule != null) {
      localStorage.setItem('circe_schedule', JSON.stringify(incoming.schedule));
      this.data.schedule = incoming.schedule;
    }
    this.updateTaskDisplay();
  }

  updateTaskDisplay() {
    const pending = (this.data.tasks || []).filter(t => !t.done);
    if (pending.length === 0) {
      this.taskListEl.innerHTML = '<div class="no-tasks">No tasks yet</div>';
      return;
    }
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const sorted = [...pending].sort((a, b) => (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3));
    this.taskListEl.innerHTML = sorted.map(t => {
      const isLocal = !t.source && t.googleId === null;
      const priBadge = t.priority ? `<span class="priority-badge ${t.priority}">${t.priority}</span>` : '';
      const ownerBadge = t.owner ? `<span class="task-owner">${this.escapeHtml(t.owner)}</span>` : '';
      return `<div class="task-item">
        <div class="task-bullet${isLocal ? ' local' : ''}"></div>
        <span class="task-label">${this.escapeHtml(t.title)}</span>
        ${priBadge}${ownerBadge}
        ${isLocal ? '<span class="task-source">local</span>' : ''}
      </div>`;
    }).join('');
  }

  updateCalendarDisplay() {
    const el = document.getElementById('calendar-list');
    if (!el) return;

    const todayStr = new Date().toISOString().slice(0, 10);
    const events = mergeUtils.mergeCalendar(this.calendarData, this.data.schedule, todayStr);

    if (events.length === 0) {
      el.innerHTML = '<div class="no-events">No upcoming events</div>';
      return;
    }
    // Group events by date
    const byDay = {};
    for (const e of events) {
      const dateKey = (e.start || '').slice(0, 10);
      if (!dateKey) continue;
      if (!byDay[dateKey]) byDay[dateKey] = [];
      byDay[dateKey].push(e);
    }

    el.innerHTML = Object.keys(byDay).sort().slice(0, 7).map(dateKey => {
      const isToday = dateKey === todayStr;
      const label = isToday ? 'Today' : new Date(dateKey + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const eventsHtml = byDay[dateKey].map(e => {
        const hasTime = e.start && e.start.includes('T');
        const timeStr = hasTime
          ? new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          : 'All day';
        return `<div class="cal-event">
          <span class="cal-time">${timeStr}</span>
          <span class="cal-title" title="${this.escapeHtml(e.title)}">${this.escapeHtml(e.title)}</span>
        </div>`;
      }).join('');
      return `<div class="cal-day">
        <div class="cal-day-label${isToday ? ' today' : ''}">${label}</div>
        ${eventsHtml}
      </div>`;
    }).join('');
  }

  async refreshSidebar() {
    // Always redraw calendar from local data; only hit the server if Google is connected
    this.updateCalendarDisplay();
    const accounts = this.getAccountsPayload();
    if (!accounts.length) return;
    try {
      const res = await fetch('/api/sidebar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ googleAccounts: accounts }),
      });
      if (!res.ok) return;
      const { calendar, tasks, googleTokenExpired } = await res.json();
      if (googleTokenExpired) {
        // Silently refresh all known token clients
        Object.values(this.tokenClients).forEach(c => c.requestAccessToken({ prompt: '' }));
        return;
      }
      if (calendar) { this.calendarData = calendar; this.updateCalendarDisplay(); }
      if (tasks) {
        this.saveData({ tasks: mergeUtils.mergeTasks(tasks, this.data.tasks) });
      }
    } catch (e) { console.error('Sidebar refresh error:', e); }
  }

  // ── Google Identity Services ─────────────────────────────────────────────

  // ── Account data helpers ─────────────────────────────────────────────────

  loadGoogleAccounts() {
    let configs = [];
    try {
      configs = JSON.parse(localStorage.getItem('circe_google_accounts') || '[]');
    } catch(e) {}

    // Migrate legacy single-token setup (google_token in sessionStorage)
    const legacyToken = sessionStorage.getItem('google_token');
    if (legacyToken && configs.length === 0) {
      configs = [{
        label: 'Google',
        email: null,
        defaults: { calendar: true, tasks: true, email: true, drive: true },
      }];
      localStorage.setItem('circe_google_accounts', JSON.stringify(configs));
      sessionStorage.setItem('circe_token__', legacyToken);
      sessionStorage.removeItem('google_token');
    }

    // Merge in short-lived tokens from sessionStorage
    return configs.map(c => ({
      ...c,
      token: sessionStorage.getItem(`circe_token_${c.email || '_'}`) || null,
    }));
  }

  saveGoogleAccountConfig() {
    // Persist only config (label, email, defaults) — tokens stay in sessionStorage
    const configs = this.googleAccounts.map(({ label, email, defaults }) => ({ label, email, defaults }));
    localStorage.setItem('circe_google_accounts', JSON.stringify(configs));
  }

  saveGoogleTokens() {
    for (const a of this.googleAccounts) {
      const key = `circe_token_${a.email || '_'}`;
      if (a.token) {
        sessionStorage.setItem(key, a.token);
      } else {
        sessionStorage.removeItem(key);
      }
    }
  }

  // Build the payload for server API calls — only accounts with valid tokens
  getAccountsPayload() {
    return this.googleAccounts
      .filter(a => a.token)
      .map(({ label, email, token, defaults }) => ({ label, email, token, defaults }));
  }

  // Client-side equivalent of server's getAccountToken
  getToken(service, preferredLabel) {
    if (!this.googleAccounts.length) return null;
    if (preferredLabel) {
      const match = this.googleAccounts.find(a => a.label?.toLowerCase() === preferredLabel.toLowerCase());
      if (match?.token) return match.token;
    }
    const def = this.googleAccounts.find(a => a.defaults?.[service] && a.token);
    return def?.token || this.googleAccounts.find(a => a.token)?.token || null;
  }

  getDefaultsForNewAccount() {
    // First account gets all defaults; subsequent accounts get none (user can toggle)
    const hasConnected = this.googleAccounts.some(a => a.token);
    if (!hasConnected) {
      return { calendar: true, tasks: true, email: true, drive: true };
    }
    return { calendar: false, tasks: false, email: false, drive: false };
  }

  // ── Google OAuth / token management ─────────────────────────────────────

  async initGoogle() {
    try {
      const res = await fetch('/api/google-client-id');
      const { clientId } = await res.json();

      if (!clientId) {
        this.loadConnectionStatus();
        return;
      }

      this.clientId = clientId;
      await this.waitForGIS();

      // Create token clients for all stored accounts so they can be silently refreshed
      for (const account of this.googleAccounts) {
        const key = account.email || '_';
        this.tokenClients[key] = this.createTokenClient(account.email);
      }

      // Trigger silent refresh for accounts that already have tokens
      const accountsWithTokens = this.googleAccounts.filter(a => a.token);
      if (accountsWithTokens.length > 0) {
        for (const account of accountsWithTokens) {
          const key = account.email || '_';
          this.tokenClients[key].requestAccessToken({ prompt: '' });
        }
      } else {
        this.loadConnectionStatus();
      }
    } catch (e) {
      console.error('Google init error:', e);
      this.loadConnectionStatus();
    }
  }

  createTokenClient(emailHint) {
    const config = {
      client_id: this.clientId,
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/drive.readonly',
      ].join(' '),
      callback: (response) => this.handleTokenResponse(response, emailHint),
    };
    if (emailHint) config.hint = emailHint;
    return google.accounts.oauth2.initTokenClient(config);
  }

  async handleTokenResponse(response, emailHint) {
    if (response.error) {
      console.error('Google token error:', response.error);
      if (emailHint) {
        const idx = this.googleAccounts.findIndex(a => a.email === emailHint);
        if (idx >= 0) {
          this.googleAccounts[idx] = { ...this.googleAccounts[idx], token: null };
          this.saveGoogleTokens();
        }
      }
      this.loadConnectionStatus();
      return;
    }

    const token = response.access_token;

    // Resolve the account's email address
    let email = emailHint;
    if (!email) {
      email = await this.fetchGoogleEmail(token);
    }

    const key = email || '_';

    // Find existing account entry or create a new one
    let idx = this.googleAccounts.findIndex(a => (a.email || null) === (email || null));
    if (idx < 0) {
      // Brand-new account being added
      this.googleAccounts.push({
        label: this.pendingAccountLabel || 'Google',
        email,
        token,
        defaults: this.getDefaultsForNewAccount(),
      });
      this.pendingAccountLabel = null;
    } else {
      // Refresh an existing account's token
      this.googleAccounts[idx] = {
        ...this.googleAccounts[idx],
        email: email || this.googleAccounts[idx].email,
        token,
      };
    }

    this.saveGoogleAccountConfig();
    this.saveGoogleTokens();

    // Ensure a persistent token client exists for refresh (e.g. after add-account flow)
    if (!this.tokenClients[key]) {
      this.tokenClients[key] = this.createTokenClient(email);
    }

    // Schedule a silent refresh 5 minutes before expiry
    clearTimeout(this.refreshTimers[key]);
    const refreshIn = ((response.expires_in || 3600) - 300) * 1000;
    this.refreshTimers[key] = setTimeout(() => {
      const client = this.tokenClients[key];
      if (client) client.requestAccessToken({ prompt: '' });
    }, refreshIn);

    this.loadConnectionStatus();
    this.syncWithGoogle();
    this.refreshSidebar();
  }

  async fetchGoogleEmail(token) {
    try {
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const info = await res.json();
      return info.email || null;
    } catch(e) {
      return null;
    }
  }

  // Add a new Google account — prompts for a nickname then opens GIS consent
  promptAddAccount() {
    const label = prompt('Give this account a nickname — for example "Work" or "Personal":');
    if (!label || !label.trim()) return;
    this.addGoogleAccount(label.trim());
  }

  addGoogleAccount(label = 'Google') {
    if (!this.clientId) {
      alert('Google Client ID not configured. Click the setup guide link above.');
      return;
    }
    this.pendingAccountLabel = label;
    // Use select_account so the user can choose which Google account to add
    const tempClient = google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/tasks',
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'https://www.googleapis.com/auth/drive.readonly',
      ].join(' '),
      callback: (response) => this.handleTokenResponse(response, null),
    });
    tempClient.requestAccessToken({ prompt: 'select_account' });
  }

  disconnectGoogleAccount(emailParam) {
    const email = emailParam || null;
    const account = this.googleAccounts.find(a => (a.email || null) === email);
    if (account?.token) {
      try { google.accounts.oauth2.revoke(account.token, () => {}); } catch(e) {}
    }
    const key = email || '_';
    clearTimeout(this.refreshTimers[key]);
    delete this.refreshTimers[key];
    delete this.tokenClients[key];
    sessionStorage.removeItem(`circe_token_${key}`);
    this.googleAccounts = this.googleAccounts.filter(a => (a.email || null) !== email);
    this.saveGoogleAccountConfig();
    this.loadConnectionStatus();
  }

  setAccountDefault(emailParam, service, isDefault) {
    const email = emailParam || null;
    if (isDefault) {
      // Only one account can be default for a given service — remove it from all others
      this.googleAccounts = this.googleAccounts.map(a => ({
        ...a,
        defaults: { ...a.defaults, [service]: (a.email || null) === email },
      }));
    } else {
      const idx = this.googleAccounts.findIndex(a => (a.email || null) === email);
      if (idx >= 0) {
        this.googleAccounts[idx] = {
          ...this.googleAccounts[idx],
          defaults: { ...this.googleAccounts[idx].defaults, [service]: false },
        };
      }
    }
    this.saveGoogleAccountConfig();
    this.loadConnectionStatus();
  }

  async syncWithGoogle() {
    if (!this.getToken('tasks')) return;
    // Local tasks with no googleId were created while offline
    const pending = (this.data.tasks || []).filter(t => !t.googleId && !t.done);
    try {
      const res = await fetch('/api/tasks/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ googleAccounts: this.getAccountsPayload(), pendingTasks: pending }),
      });
      if (!res.ok) return;
      const { tasks } = await res.json();
      this.saveData({ tasks });
      if (pending.length > 0) {
        const n = pending.length;
        const msg = `I found ${n} task${n > 1 ? 's' : ''} you saved while offline. I've added ${n > 1 ? 'them' : 'it'} to Google for you.`;
        this.addBubble('circe', msg);
        await this.speak(msg);
      }
    } catch(e) {
      console.error('Task sync error:', e);
    }
  }

  waitForGIS() {
    return new Promise((resolve) => {
      if (window.google?.accounts?.oauth2) { resolve(); return; }
      const interval = setInterval(() => {
        if (window.google?.accounts?.oauth2) {
          clearInterval(interval);
          resolve();
        }
      }, 100);
      // Give up after 5s (works offline / no client ID)
      setTimeout(() => { clearInterval(interval); resolve(); }, 5000);
    });
  }

  // Backwards-compat: connect = add first account
  connectGoogle() {
    this.promptAddAccount();
  }

  // Backwards-compat: disconnect = remove all accounts
  disconnectGoogle() {
    for (const account of [...this.googleAccounts]) {
      this.disconnectGoogleAccount(account.email);
    }
    this.loadConnectionStatus();
  }

  // ── Speech recognition ──────────────────────────────────────────────────────

  setupRecognition() {
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';
    this.recognition.maxAlternatives = 1;

    this.recognition.onresult = (e) => this.onSpeechResult(e);
    this.recognition.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        console.warn('Speech error:', e.error);
      }
    };
    this.recognition.onend = () => {
      // Always restart — barge-in requires the mic to stay live during speech
      setTimeout(() => {
        try { this.recognition.start(); } catch(e) {}
      }, 200);
    };
  }

  onSpeechResult(event) {
    // Collect all results from this event
    let interim = '';
    let final = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        final += result[0].transcript;
      } else {
        interim += result[0].transcript;
      }
    }

    const combined = (final + interim).toLowerCase().trim();

    const wakeWords = ['circe', 'surce', 'searcy', 'searsy', 'sirsy', 'percy', 'mercy', 'sir-c', 'sirc'];

    if (this.state === 'speaking' && this.bargeInReady) {
      // Barge-in: user spoke while Circe was talking
      if (this.conversationMode) {
        // Chat mode: any utterance interrupts and gets processed as a command
        if (final.trim().length > 2) {
          this.cancelTTS();
          const cleaned = final.trim().replace(/^(hey\s+)?(circe|surce|searcy|searsy|sirsy|percy|mercy|sir-c|sirc)[,.]?\s*/i, '').trim();
          if (cleaned.length > 1) this.processCommand(cleaned);
          else this.activate();
        }
      } else {
        // Outside chat mode: only the wake word interrupts
        if (wakeWords.some(w => combined.includes(w))) {
          this.cancelTTS();
          this.setState('standby', 'Say "Hey Circe" to begin');
          this.activate();
        }
      }
      return;
    }

    if (this.state === 'standby') {
      // Watch for wake word — include phonetic mishearings of "Circe"
      if (wakeWords.some(w => combined.includes(w))) {
        this.activate();
      }
    } else if (this.state === 'listening') {
      // Show interim results
      if (interim) this.interimEl.textContent = interim;

      // Process final result
      if (final.trim()) {
        // Strip any variant of the wake word before sending to Circe
        const wakePattern = /^(hey\s+)?(circe|surce|searcy|searsy|sirsy|percy|mercy|sir-c|sirc)[,.]?\s*/i;
        const cleaned = final.trim().replace(wakePattern, '').trim();
        if (cleaned.length > 1) {
          this.processCommand(cleaned);
        }
      }
    }
  }

  activate() {
    if (this.state !== 'standby') return;
    this.setState('listening', 'Listening…');
    this.interimEl.textContent = '';
    this.playChime();

    // In chat mode the mic stays open indefinitely — no timeout
    if (this.conversationMode) return;

    // Outside chat mode: auto-timeout after 12 seconds of silence
    clearTimeout(this.listenTimeout);
    this.listenTimeout = setTimeout(() => {
      if (this.state === 'listening') {
        this.setState('standby', "Say \"Hey Circe\" to begin");
        this.interimEl.textContent = '';
      }
    }, 12000);
  }

  handleOrbClick() {
    if (this.conversationMode) {
      // Clicking orb exits conversation mode
      this.cancelTTS();
      this.toggleConversationMode(false);
      return;
    }
    if (this.state === 'standby') {
      this.activate();
    } else if (this.state === 'speaking') {
      this.cancelTTS();
      this.setState('standby', "Say \"Hey Circe\" to begin");
    }
  }

  toggleConversationMode(force) {
    this.conversationMode = (force !== undefined) ? force : !this.conversationMode;
    const btn = document.getElementById('conv-btn');
    if (btn) btn.classList.toggle('active', this.conversationMode);
    if (this.conversationMode) {
      // Force back to standby first in case the app is stuck in another state
      this.cancelTTS();
      this.setState('standby', 'Chat mode — listening after each response');
      this.activate();
    } else {
      this.cancelTTS();
      this.setState('standby', "Say \"Hey Circe\" to begin");
    }
  }

  // ── Chat ────────────────────────────────────────────────────────────────────

  async processCommand(text) {
    clearTimeout(this.listenTimeout);
    this.cancelTTS();

    // Handle client-side commands (no server round-trip needed)
    const lc = text.toLowerCase().trim();

    if (/\b(what can you do|what do you do|how do you work|help|what are your commands|what can i say)\b/.test(lc)) {
      const msg = 'Here\'s what I can do. For tasks, say: add a task, mark it done, what are my tasks, or set this to high priority. For your schedule, say: add an event, what\'s on my schedule, or what\'s today. For email, say: check my email, read that email, or send an email. For anything else, say: search the web for, find a file in Drive, or remind me. Say "start chat mode" to keep me listening, or "Hey Circe" any time to get my attention. And you can always say "consult your advisor" for a deeper answer.';
      this.addBubble('circe', msg);
      await this.speak(msg);
      if (this.conversationMode) this.activate();
      return;
    }

    // If completions are pending, intercept number/word selection
    if (this.pendingCompletions.length > 0) {
      const pick = lc.match(/^(one|two|three|four|1|2|3|4)\b/);
      const idx = pick ? ['one','1','two','2','three','3','four','4'].indexOf(pick[0]) : -1;
      const choiceIdx = idx >= 0 ? Math.floor(idx / 2) : -1;
      if (choiceIdx >= 0 && choiceIdx < this.pendingCompletions.length) {
        const chosen = this.pendingCompletions[choiceIdx];
        this.pendingCompletions = [];
        document.querySelectorAll('.completion-picker').forEach(el => el.remove());
        await this.processCommand(chosen);
        return;
      }
      // If they said something that isn't a number, clear completions and proceed normally
      this.pendingCompletions = [];
      document.querySelectorAll('.completion-picker').forEach(el => el.remove());
    }

    if (this.conversationMode && /\b(end chat mode|stop chat mode|chat mode off|stop listening|goodbye|that'?s all|done|bye)\b/.test(lc)) {
      this.toggleConversationMode(false);
      const msg = 'Okay, going quiet. Say "Hey Circe" whenever you need me.';
      this.addBubble('circe', msg);
      await this.speak(msg);
      return;
    }

    if (/\b(start chat mode|chat mode on|chat mode|keep listening|stay on)\b/.test(lc)) {
      this.toggleConversationMode(true);
      const msg = 'Chat mode on. I\'ll keep listening after each response. Say "end chat mode" or "stop listening" when you\'re done.';
      this.addBubble('circe', msg);
      await this.speak(msg);
      this.toggleConversationMode(true); // re-activate after speaking
      return;
    }

    this.setState('processing', 'Thinking…');
    this.interimEl.textContent = '';
    this.addBubble('user', text);

    this.conversation.push({ role: 'user', content: text });

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: this.conversation,
          localData: this.data,
          googleAccounts: this.getAccountsPayload(),
          useConsultant: this.useConsultant
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Server error ${res.status}`);
      }
      const json = await res.json();

      if (json.localData) this.saveData(json.localData);
      if (json.googleTokenExpired) {
        Object.values(this.tokenClients).forEach(c => c.requestAccessToken({ prompt: '' }));
      }
      if (json.calendar) { this.calendarData = json.calendar; this.updateCalendarDisplay(); }
      this.conversation.push({ role: 'assistant', content: json.response });

      // Keep conversation from growing too large
      if (this.conversation.length > 30) {
        this.conversation = this.conversation.slice(-20);
      }

      // If Circe suggests consulting the advisor, auto-escalate
      if (json.needsConsultant) {
        this.useConsultant = true;
        await this.reprocessLastWithConsultant();
        return;
      }
      this.useConsultant = false;

      this.addBubble('circe', json.response);

      // If Circe is offering completions, show a numbered picker and store state
      if (json.completions && json.completions.length > 0) {
        this.pendingCompletions = json.completions;
        this.addCompletionPicker(json.completions);
      }

      await this.speak(json.response);
      this.refreshSidebar();

    } catch (err) {
      console.error(err);
      // err.message may be the friendly string from the server, or a network error
      const serverMsg = err.message && !err.message.startsWith('{') && !err.message.match(/^\d{3}/)
        ? err.message
        : "Something went wrong. Let's try that again.";
      this.addBubble('circe', serverMsg);
      await this.speak(serverMsg);
    }

    if (this.conversationMode) {
      // done() in speak() already set state to 'listening'; recover if speak() wasn't called
      if (this.state !== 'listening') {
        this.setState('listening', 'Listening…');
      }
    } else {
      this.setState('standby', "Say \"Hey Circe\" to begin");
    }
  }

  async reprocessLastWithConsultant() {
    // Remove the last assistant message and re-call with Opus
    this.conversation = this.conversation.slice(0, -1);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: this.conversation,
          localData: this.data,
          googleAccounts: this.getAccountsPayload(),
          useConsultant: true
        })
      });
      const json = await res.json();
      if (json.localData) this.saveData(json.localData);
      this.conversation.push({ role: 'assistant', content: json.response });
      this.useConsultant = false;

      this.addBubble('circe', json.response);
      await this.speak(json.response);
    } catch (err) {
      const msg = "I couldn't reach my advisor. Let me try to help directly.";
      this.addBubble('circe', msg);
      await this.speak(msg);
    }

    if (this.conversationMode) {
      this.activate();
    } else {
      this.setState('standby', "Say \"Hey Circe\" to begin");
    }
  }

  // ── Text input fallback ─────────────────────────────────────────────────────

  sendTextInput() {
    const input = document.getElementById('text-input');
    const text = input.value.trim();
    // Block only if already processing a request (not speaking — speaking can be interrupted)
    if (!text || this.state === 'processing') return;
    input.value = '';
    this.processCommand(text);
  }

  // ── Speech synthesis ─────────────────────────────────────────────────────────

  speak(text) {
    return new Promise((resolve) => {
      this.setState('speaking', 'Speaking…');

      // Grace period: don't allow barge-in for the first 600ms so the mic
      // doesn't catch the very start of Circe's own voice and self-interrupt
      this.bargeInReady = false;
      clearTimeout(this._bargeInTimer);
      this._bargeInTimer = setTimeout(() => { this.bargeInReady = true; }, 600);

      // done() resets state — called once regardless of path
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(watchdog);
        clearTimeout(this._bargeInTimer);
        this.bargeInReady = false;
        this._currentTTSAudio = null;
        // In chat mode go straight to listening — skip standby to avoid the wake-word gap
        if (this.conversationMode) {
          this.setState('listening', 'Listening…');
        } else {
          this.setState('standby', 'Say "Hey Circe" to begin');
        }
        resolve();
      };

      // Watchdog: recover if audio never fires ended/error after a generous estimate
      const estimatedMs = Math.max(5000, text.length * 60);
      const watchdog = setTimeout(done, estimatedMs);

      if (this._useMacOSTTS) {
        // Use macOS say via server — produces much more natural audio
        fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, voice: this.ttsVoice }),
        }).then(res => {
          if (!res.ok) throw new Error('tts error');
          return res.blob();
        }).then(blob => {
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          this._currentTTSAudio = audio;
          audio.onended = () => { URL.revokeObjectURL(url); done(); };
          audio.onerror = () => { URL.revokeObjectURL(url); done(); };
          audio.play().catch(() => done());
        }).catch(() => {
          // macOS TTS failed mid-session; fall back to browser
          this._speakViaBrowser(text, done, finished);
        });
      } else {
        // Browser Web Speech API (also used as fallback)
        this._speakViaBrowser(text, done, finished);
      }
    });
  }

  _speakViaBrowser(text, done, finished) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.9;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    const voices = speechSynthesis.getVoices();
    const enVoices = voices.filter(v => v.lang.startsWith('en'));
    const preferred =
      enVoices.find(v => v.name.includes('Enhanced')) ||
      enVoices.find(v => v.lang === 'en-US' && v.localService);
    if (preferred) utterance.voice = preferred;
    utterance.onend   = done;
    utterance.onerror = done;
    speechSynthesis.speak(utterance);
    // Secondary check: if browser silently drops utterance within 1s, recover
    setTimeout(() => {
      if (!finished && !speechSynthesis.speaking && !speechSynthesis.pending) done();
    }, 1000);
  }

  cancelTTS() {
    // Cancel macOS audio element if active
    if (this._currentTTSAudio) {
      this._currentTTSAudio.pause();
      this._currentTTSAudio = null;
    }
    // Also cancel browser TTS in case fallback is in use
    speechSynthesis.cancel();
  }

  async loadTTSVoice() {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) return;
      const s = await res.json();
      if (s.TTS_VOICE) this.ttsVoice = s.TTS_VOICE;
      this._useMacOSTTS = true; // server is up and macOS TTS is available
    } catch (_) {}
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  setState(state, label) {
    this.state = state;
    document.body.className = state;
    if (label) this.statusEl.textContent = label;
  }

  addBubble(who, text) {
    const div = document.createElement('div');
    div.className = `message ${who}`;
    div.innerHTML = `<div class="speaker">${who === 'user' ? 'You' : '✦ Circe'}</div>${this.escapeHtml(text)}`;
    this.convEl.appendChild(div);
    // Use rAF so the element is in the layout before we scroll
    requestAnimationFrame(() => div.scrollIntoView({ behavior: 'smooth', block: 'end' }));
  }

  addCompletionPicker(options) {
    const div = document.createElement('div');
    div.className = 'completion-picker';
    const labels = ['1', '2', '3', '4'];
    div.innerHTML = options.map((opt, i) =>
      `<button class="completion-btn" data-index="${i}">${labels[i]}. ${this.escapeHtml(opt)}</button>`
    ).join('');
    this.convEl.appendChild(div);
    div.querySelectorAll('.completion-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.index, 10);
        this.pendingCompletions = [];
        document.querySelectorAll('.completion-picker').forEach(el => el.remove());
        this.processCommand(options[idx]);
      });
    });
    requestAnimationFrame(() => div.scrollIntoView({ behavior: 'smooth', block: 'end' }));
  }

  escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  playChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch(e) {}
  }

  async openSettings() {
    const modal = document.getElementById('settings-modal');
    modal.style.display = 'flex';
    document.getElementById('settings-msg').style.display = 'none';
    try {
      const [settingsRes, voicesRes] = await Promise.all([
        fetch('/api/settings'),
        fetch('/api/tts/voices'),
      ]);
      const s = await settingsRes.json();
      const { voices } = await voicesRes.json();

      document.getElementById('s-google-id').value = s.GOOGLE_CLIENT_ID || '';

      const sel = document.getElementById('s-tts-voice');
      const current = s.TTS_VOICE || 'Samantha';
      sel.innerHTML = voices.map(v =>
        `<option value="${v.name}"${v.name === current ? ' selected' : ''}>${v.name}</option>`
      ).join('') || '<option value="Samantha">Samantha</option>';
    } catch(e) {}
  }

  async previewVoice() {
    const voice = document.getElementById('s-tts-voice')?.value || this.ttsVoice;
    const prev = this.ttsVoice;
    this.ttsVoice = voice;
    await this.speak('Hi, I\'m Circe. How does this voice sound?');
    this.ttsVoice = prev; // restore until saved
  }

  closeSettings() {
    document.getElementById('settings-modal').style.display = 'none';
  }

  async saveSettings() {
    const voice = document.getElementById('s-tts-voice')?.value;
    if (voice) this.ttsVoice = voice;
    const body = {
      GOOGLE_CLIENT_ID: document.getElementById('s-google-id').value,
      TTS_VOICE: voice || this.ttsVoice,
    };
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    document.getElementById('settings-msg').style.display = 'block';
    // Re-init Google with the new client ID
    await this.initGoogle();
  }

  loadConnectionStatus() {
    const el = document.getElementById('accounts-status');
    if (!el) return;

    fetch('/api/connections').then(r => r.json()).then(({ google }) => {
      if (!google.configured) {
        el.innerHTML = `<div class="account-row">
          <span class="unconfigured">✗ Google</span>
          <a href="/setup-google.html">Set up</a>
        </div>`;
        return;
      }

      const connectedAccounts = this.googleAccounts.filter(a => a.token);
      const SERVICES = ['calendar', 'tasks', 'email', 'drive'];
      const SERVICE_LABELS = { calendar: 'Cal', tasks: 'Tasks', email: 'Email', drive: 'Drive' };

      let html = '';

      if (connectedAccounts.length === 0) {
        html = `<div class="account-row">
          <span class="disconnected">○ Google</span>
          <a href="#" onclick="app.connectGoogle(); return false;">Connect</a>
        </div>`;
      } else {
        for (const account of connectedAccounts) {
          const displayName = account.label || 'Google';
          const emailStr = account.email
            ? `<div class="account-email">${this.escapeHtml(account.email)}</div>`
            : '';
          const emailJson = JSON.stringify(account.email || '');
          const pills = SERVICES.map(svc => {
            const active = account.defaults?.[svc] ? ' active' : '';
            const nextState = !account.defaults?.[svc];
            return `<span class="default-pill${active}"
              onclick="app.setAccountDefault(${emailJson}, '${svc}', ${nextState}); return false;"
              title="${account.defaults?.[svc] ? 'Default for ' + svc + ' — click to remove' : 'Click to set as default for ' + svc}"
              >${SERVICE_LABELS[svc]}</span>`;
          }).join('');

          html += `<div class="account-card">
            <div class="account-card-header">
              <span class="connected">✓ ${this.escapeHtml(displayName)}</span>
              <a href="#" onclick="app.disconnectGoogleAccount(${emailJson}); return false;">Disconnect</a>
            </div>
            ${emailStr}
            <div class="account-defaults">${pills}</div>
          </div>`;
        }
        html += `<div class="account-row add-account-row">
          <a href="#" onclick="app.promptAddAccount(); return false;">+ Add account</a>
        </div>`;
      }

      el.innerHTML = html;
    }).catch(() => {});
  }

  async greet() {
    // Wait briefly for voices to finish loading
    await new Promise(r => setTimeout(r, 1000));
    if (this.state !== 'standby') return;
    const text = mergeUtils.buildStartupSpeech(this.data.tasks, this.data.schedule);
    this.addBubble('circe', text);
    await this.speak(text);
    // speak() resets state to standby — ready for wake word
  }
}

// ── Debug helper: run listVoices() in browser console to see available voices ─
window.listVoices = () => {
  speechSynthesis.getVoices()
    .filter(v => v.lang.startsWith('en'))
    .forEach(v => console.log(`${v.name} | ${v.lang} | local:${v.localService}`));
};

// ── Boot ──────────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  // Node/Jest: export class for testing (no auto-boot)
  module.exports = { CirceApp };
} else {
  window.addEventListener('load', () => {
    // Voices may load async in some browsers
    if (speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = () => {};
    }
    window.app = new CirceApp();
  });
}
