// ── Circe Voice App ──────────────────────────────────────────────────────────

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

class CirceApp {
  constructor() {
    this.state = 'standby';        // standby | listening | processing | speaking
    this.recognition = null;
    this.conversation = [];        // sent to server each turn
    this.data = this.loadData();
    this.useConsultant = false;

    // Google token (short-lived, from GIS; refreshed when expired)
    this.googleToken = sessionStorage.getItem('google_token') || null;
    this.tokenClient = null;

    this.statusEl = document.getElementById('status-text');
    this.interimEl = document.getElementById('interim-text');
    this.convEl = document.getElementById('conversation');
    this.taskListEl = document.getElementById('task-list');

    this.updateTaskDisplay();
    this.initGoogle();   // sets up GIS, then loads connection status

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
    this.taskListEl.innerHTML = pending.map(t =>
      `<div class="task-item">
        <div class="task-bullet"></div>
        <span>${this.escapeHtml(t.title)}</span>
      </div>`
    ).join('');
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
        ].join(' '),
        callback: (response) => {
          if (response.error) {
            console.error('Google sign-in error:', response.error);
            return;
          }
          this.googleToken = response.access_token;
          sessionStorage.setItem('google_token', response.access_token);
          this.loadConnectionStatus(true);
        },
      });

      this.loadConnectionStatus(!!this.googleToken);
    } catch (e) {
      console.error('Google init error:', e);
      this.loadConnectionStatus(false);
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
        // Don't process the wake word itself as a command
        const cleaned = final.trim().toLowerCase()
          .replace(/^(hey\s+)?circe[,.]?\s*/i, '')
          .trim();
        if (cleaned.length > 1) {
          this.processCommand(final.trim());
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
    this.convEl.scrollTop = this.convEl.scrollHeight;
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
      document.getElementById('s-ms-id').value = s.MICROSOFT_CLIENT_ID || '';
      document.getElementById('s-ms-secret').value = s.MICROSOFT_CLIENT_SECRET || '';
    } catch(e) {}
  }

  closeSettings() {
    document.getElementById('settings-modal').style.display = 'none';
  }

  async saveSettings() {
    const body = {
      GOOGLE_CLIENT_ID:        document.getElementById('s-google-id').value,
      MICROSOFT_CLIENT_ID:     document.getElementById('s-ms-id').value,
      MICROSOFT_CLIENT_SECRET: document.getElementById('s-ms-secret').value,
    };
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    document.getElementById('settings-msg').style.display = 'block';
    // Re-init Google with the new client ID
    await this.initGoogle();
  }

  loadConnectionStatus(googleConnected) {
    const el = document.getElementById('accounts-status');
    if (!el) return;

    // Check if Google client ID is configured
    fetch('/api/connections').then(r => r.json()).then(({ google, microsoft }) => {
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

      const msConnected = microsoft.connected;
      const msConfigured = microsoft.configured;
      let msHtml;
      if (!msConfigured) {
        msHtml = `<div class="account-row">
          <span class="unconfigured">✗ Microsoft</span>
          <span class="hint">Add to Settings</span>
        </div>`;
      } else if (msConnected) {
        msHtml = `<div class="account-row">
          <span class="connected">✓ Microsoft</span>
          <a href="/auth/microsoft/disconnect">Disconnect</a>
        </div>`;
      } else {
        msHtml = `<div class="account-row">
          <span class="disconnected">○ Microsoft</span>
          <a href="/auth/microsoft">Connect</a>
        </div>`;
      }

      el.innerHTML = googleHtml + msHtml;
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
