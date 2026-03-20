// ── Circe Voice App ──────────────────────────────────────────────────────────

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

class CirceApp {
  constructor() {
    this.state = 'standby';        // standby | listening | processing | speaking
    this.recognition = null;
    this.conversation = [];        // sent to server each turn
    this.data = this.loadData();
    this.useConsultant = false;

    // Google token (short-lived, from GIS; refreshed automatically)
    this.googleToken = sessionStorage.getItem('google_token') || null;
    this.tokenClient = null;
    this.tokenRefreshTimer = null;

    this.calendarData = [];    // latest calendar events from server

    this.statusEl = document.getElementById('status-text');
    this.interimEl = document.getElementById('interim-text');
    this.convEl = document.getElementById('conversation');
    this.taskListEl = document.getElementById('task-list');

    this.updateTaskDisplay();
    this.initGoogle();      // sets up GIS, then loads connection status

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
    this.taskListEl.innerHTML = pending.map(t => {
      const isLocal = !t.source && t.googleId === null;
      return `<div class="task-item">
        <div class="task-bullet${isLocal ? ' local' : ''}"></div>
        <span class="task-label">${this.escapeHtml(t.title)}</span>
        ${isLocal ? '<span class="task-source">local</span>' : ''}
      </div>`;
    }).join('');
  }

  updateCalendarDisplay() {
    const el = document.getElementById('calendar-list');
    if (!el) return;
    const events = this.calendarData;
    if (!events || events.length === 0) {
      el.innerHTML = '<div class="no-events">No upcoming events</div>';
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
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
    if (!this.googleToken) return;
    try {
      const res = await fetch('/api/sidebar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ googleToken: this.googleToken }),
      });
      if (!res.ok) return;
      const { calendar, tasks, googleTokenExpired } = await res.json();
      if (googleTokenExpired && this.tokenClient) {
        this.tokenClient.requestAccessToken({ prompt: '' });
        return;
      }
      if (calendar) { this.calendarData = calendar; this.updateCalendarDisplay(); }
      if (tasks) { this.saveData({ tasks }); }
    } catch (e) { console.error('Sidebar refresh error:', e); }
  }

  // ── Google Identity Services ─────────────────────────────────────────────

  async initGoogle() {
    try {
      const res = await fetch('/api/google-client-id');
      const { clientId } = await res.json();

      if (!clientId) {
        this.loadConnectionStatus(false);
        return;
      }

      // Wait for the GIS library to load (it loads async)
      await this.waitForGIS();

      this.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/tasks',
          'https://www.googleapis.com/auth/gmail.readonly',
          'https://www.googleapis.com/auth/gmail.send',
        ].join(' '),
        callback: (response) => {
          if (response.error) {
            console.error('Google sign-in error:', response.error);
            // Silent refresh failed — clear the stale token and show disconnected
            this.googleToken = null;
            sessionStorage.removeItem('google_token');
            this.loadConnectionStatus(false);
            return;
          }
          this.googleToken = response.access_token;
          sessionStorage.setItem('google_token', response.access_token);
          // Schedule a silent refresh 5 minutes before the token expires
          clearTimeout(this.tokenRefreshTimer);
          const refreshIn = ((response.expires_in || 3600) - 300) * 1000;
          this.tokenRefreshTimer = setTimeout(() => {
            this.tokenClient.requestAccessToken({ prompt: '' });
          }, refreshIn);
          this.loadConnectionStatus(true);
          this.syncWithGoogle();
          this.refreshSidebar();
        },
      });

      if (this.googleToken) {
        // Silently validate and refresh the stored token on every page load.
        // The callback handles success (fresh token + timer) and failure (clears stale token).
        this.tokenClient.requestAccessToken({ prompt: '' });
      } else {
        this.loadConnectionStatus(false);
      }
    } catch (e) {
      console.error('Google init error:', e);
      this.loadConnectionStatus(false);
    }
  }

  async syncWithGoogle() {
    if (!this.googleToken) return;
    // Local tasks with no googleId were created while offline
    const pending = (this.data.tasks || []).filter(t => !t.googleId && !t.done);
    try {
      const res = await fetch('/api/tasks/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ googleToken: this.googleToken, pendingTasks: pending }),
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

  connectGoogle() {
    if (!this.tokenClient) {
      alert('Google Client ID not configured. Click the setup guide link above.');
      return;
    }
    this.tokenClient.requestAccessToken();
  }

  disconnectGoogle() {
    if (this.googleToken) {
      google.accounts.oauth2.revoke(this.googleToken, () => {});
    }
    this.googleToken = null;
    sessionStorage.removeItem('google_token');
    this.loadConnectionStatus(false);
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
      // Restart unless we're speaking (avoid feedback loop)
      if (this.state !== 'speaking') {
        setTimeout(() => {
          try { this.recognition.start(); } catch(e) {}
        }, 200);
      }
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

    if (this.state === 'standby') {
      // Watch for wake word — include phonetic mishearings of "Circe"
      const wakeWords = ['circe', 'surce', 'searcy', 'searsy', 'sirsy', 'percy', 'mercy', 'sir-c', 'sirc'];
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

    // Auto-timeout after 12 seconds of silence
    clearTimeout(this.listenTimeout);
    this.listenTimeout = setTimeout(() => {
      if (this.state === 'listening') {
        this.setState('standby', "Say \"Hey Circe\" to begin");
        this.interimEl.textContent = '';
      }
    }, 12000);
  }

  handleOrbClick() {
    if (this.state === 'standby') {
      this.activate();
    } else if (this.state === 'speaking') {
      speechSynthesis.cancel();
      this.setState('standby', "Say \"Hey Circe\" to begin");
    }
  }

  // ── Chat ────────────────────────────────────────────────────────────────────

  async processCommand(text) {
    clearTimeout(this.listenTimeout);
    // Interrupt any ongoing speech before processing the new command
    if (speechSynthesis.speaking) speechSynthesis.cancel();
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
          googleToken: this.googleToken,
          useConsultant: this.useConsultant
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Server error ${res.status}`);
      }
      const json = await res.json();

      if (json.localData) this.saveData(json.localData);
      if (json.googleTokenExpired && this.tokenClient) {
        this.tokenClient.requestAccessToken({ prompt: '' });
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
      await this.speak(json.response);

    } catch (err) {
      console.error(err);
      const msg = `I'm sorry, something went wrong. ${err.message || 'Please try again.'}`;
      this.addBubble('circe', msg);
      await this.speak(msg);
    }

    this.setState('standby', "Say \"Hey Circe\" to begin");
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
          googleToken: this.googleToken,
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

    this.setState('standby', "Say \"Hey Circe\" to begin");
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

      // Stop listening while speaking to avoid hearing our own voice
      try { this.recognition.stop(); } catch(e) {}

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.9;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;

      const voices = speechSynthesis.getVoices();
      const enVoices = voices.filter(v => v.lang.startsWith('en'));

      // Priority: Enhanced/Premium > specific natural names > any local en-US > any en
      const preferred =
        enVoices.find(v => v.name === 'Moira') ||
        enVoices.find(v => v.name.includes('Enhanced')) ||
        enVoices.find(v => v.lang === 'en-US' && v.localService);
      if (preferred) utterance.voice = preferred;

      utterance.onend = () => {
        resolve();
        // Resume listening
        try { this.recognition.start(); } catch(e) {}
      };
      utterance.onerror = () => {
        resolve();
        try { this.recognition.start(); } catch(e) {}
      };

      speechSynthesis.speak(utterance);
    });
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
      const res = await fetch('/api/settings');
      const s = await res.json();
      document.getElementById('s-google-id').value = s.GOOGLE_CLIENT_ID || '';
    } catch(e) {}
  }

  closeSettings() {
    document.getElementById('settings-modal').style.display = 'none';
  }

  async saveSettings() {
    const body = {
      GOOGLE_CLIENT_ID: document.getElementById('s-google-id').value,
    };
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    document.getElementById('settings-msg').style.display = 'block';
    // Re-init Google with the new client ID
    await this.initGoogle();
  }

  loadConnectionStatus(googleConnected) {
    const el = document.getElementById('accounts-status');
    if (!el) return;

    fetch('/api/connections').then(r => r.json()).then(({ google }) => {
      const gConnected = googleConnected !== undefined ? googleConnected : !!this.googleToken;
      const gConfigured = google.configured;

      let googleHtml;
      if (!gConfigured) {
        googleHtml = `<div class="account-row">
          <span class="unconfigured">✗ Google</span>
          <a href="/setup-google.html">Set up</a>
        </div>`;
      } else if (gConnected) {
        googleHtml = `<div class="account-row">
          <span class="connected">✓ Google</span>
          <a href="#" onclick="app.disconnectGoogle(); return false;">Disconnect</a>
        </div>`;
      } else {
        googleHtml = `<div class="account-row">
          <span class="disconnected">○ Google</span>
          <a href="#" onclick="app.connectGoogle(); return false;">Connect</a>
        </div>`;
      }

      el.innerHTML = googleHtml;
    }).catch(() => {});
  }

  greet() {
    // Brief welcome when the app first loads (no voice, just UI)
    setTimeout(() => {
      if (this.state === 'standby') {
        this.addBubble('circe', "Hi Duchess! I'm Circe. Say \"Hey Circe\" whenever you need me.");
      }
    }, 800);
  }
}

// ── Debug helper: run listVoices() in browser console to see available voices ─
window.listVoices = () => {
  speechSynthesis.getVoices()
    .filter(v => v.lang.startsWith('en'))
    .forEach(v => console.log(`${v.name} | ${v.lang} | local:${v.localService}`));
};

// ── Boot ──────────────────────────────────────────────────────────────────────

let app;
window.addEventListener('load', () => {
  // Voices may load async in some browsers
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = () => {};
  }
  app = new CirceApp();
});
