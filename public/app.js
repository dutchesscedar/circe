// ── Circe Voice App ──────────────────────────────────────────────────────────

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

class CirceApp {
  constructor() {
    this.state = 'standby';        // standby | listening | processing | speaking
    this.recognition = null;
    this.conversation = [];        // sent to server each turn
    this.data = this.loadData();
    this.useConsultant = false;

    this.statusEl = document.getElementById('status-text');
    this.interimEl = document.getElementById('interim-text');
    this.convEl = document.getElementById('conversation');
    this.taskListEl = document.getElementById('task-list');

    this.updateTaskDisplay();
    this.loadConnectionStatus();

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
      // Watch for wake word
      if (combined.includes('circe')) {
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
          useConsultant: this.useConsultant
        })
      });

      if (!res.ok) throw new Error(`Server error ${res.status}`);
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
      const msg = "I'm sorry, something went wrong. Please try again.";
      this.addBubble('circe', msg);
      await this.speak(msg);
    }

    this.setState('standby', "Say \"Hey Circe\" to begin");
  }

  async reprocessLastWithConsultant() {
    // Remove the last assistant message and re-call with Opus
    this.conversation = this.conversation.slice(0, -1);
    const lastUser = this.conversation[this.conversation.length - 1].content;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: this.conversation, data: this.data, useConsultant: true })
      });
      const json = await res.json();
      if (json.data) this.saveData(json.data);
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
      utterance.rate = 0.92;
      utterance.pitch = 1.05;
      utterance.volume = 1.0;

      // Prefer a natural-sounding voice
      const voices = speechSynthesis.getVoices();
      const preferred = voices.find(v => v.name.includes('Samantha') || v.name.includes('Karen') || v.name.includes('Moira'))
        || voices.find(v => v.lang === 'en-US' && !v.name.includes('(Google)'));
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

  async loadConnectionStatus() {
    try {
      const res = await fetch('/api/connections');
      const { google, microsoft } = await res.json();
      const el = document.getElementById('accounts-status');
      if (!el) return;
      el.innerHTML = `
        <div class="account-row">
          <span class="${google.connected ? 'connected' : google.configured ? 'disconnected' : 'unconfigured'}">
            ${google.connected ? '✓' : '✗'} Google
          </span>
          ${google.configured
            ? `<a href="${google.connected ? '/auth/google/disconnect' : '/auth/google'}">${google.connected ? 'Disconnect' : 'Connect'}</a>`
            : '<span class="hint">Add to .env</span>'}
        </div>
        <div class="account-row">
          <span class="${microsoft.connected ? 'connected' : microsoft.configured ? 'disconnected' : 'unconfigured'}">
            ${microsoft.connected ? '✓' : '✗'} Microsoft
          </span>
          ${microsoft.configured
            ? `<a href="${microsoft.connected ? '/auth/microsoft/disconnect' : '/auth/microsoft'}">${microsoft.connected ? 'Disconnect' : 'Connect'}</a>`
            : '<span class="hint">Add to .env</span>'}
        </div>`;
    } catch(e) {}
  }

  greet() {
    // Brief welcome when the app first loads (no voice, just UI)
    setTimeout(() => {
      if (this.state === 'standby') {
        this.addBubble('circe', "Hi Kate! I'm Circe. Say \"Hey Circe\" whenever you need me.");
      }
    }, 800);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

let app;
window.addEventListener('load', () => {
  // Voices may load async in some browsers
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = () => {};
  }
  app = new CirceApp();
});
