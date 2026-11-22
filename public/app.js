(() => {
  const urlParams = new URLSearchParams(window.location.search);
  const isOverlay = urlParams.get('overlay') === '1' || urlParams.get('obs') === '1';
  if (isOverlay) document.body.classList.add('obs-mode');

  // ==================== MODERN WEBAUDIO ENGINE ====================
  const SoundEngine = {
    ctx: null,
    muted: false,
    master: null,
    reverbIn: null,

    ensureCtx() {
      if (!this.ctx) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          this.ctx = new AudioCtx();
          const comp = this.ctx.createDynamicsCompressor();
          comp.threshold.value = -18;
          comp.ratio.value = 3.5;
          const master = this.ctx.createGain();
          master.gain.value = 0.85;
          master.connect(comp);
          comp.connect(this.ctx.destination);

          const len = Math.floor(this.ctx.sampleRate * 1.8);
          const buf = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
          for (let ch = 0; ch < 2; ch++) {
            const d = buf.getChannelData(ch);
            for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
          }
          const conv = this.ctx.createConvolver();
          conv.buffer = buf;
          const wet = this.ctx.createGain();
          wet.gain.value = 0.25;
          conv.connect(wet);
          wet.connect(master);
          this.master = master;
          this.reverbIn = conv;
        }
      }
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return this.ctx;
    },

    tone(freq, dur, opts = {}) {
      if (this.muted) return;
      const ctx = this.ensureCtx();
      if (!ctx || !this.master) return;
      const { type = 'sine', vol = 0.08, delay = 0, glide = null, wet = true } = opts;
      const t = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t);
      if (glide) osc.frequency.exponentialRampToValueAtTime(glide, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g);
      g.connect(this.master);
      if (wet && this.reverbIn) g.connect(this.reverbIn);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    },

    playJoin() {
      this.tone(520, 0.14, { vol: 0.05, glide: 780 });
    },

    playStart() {
      [440, 554.37, 659.25, 880].forEach((f, i) => this.tone(f, 0.45, { delay: i * 0.06, vol: 0.065 }));
    },

    playSkill(skill) {
      if (skill === 1) this.tone(360, 0.22, { vol: 0.06, glide: 900 });
      else if (skill === 2) {
        this.tone(587.33, 0.35, { vol: 0.06 });
        this.tone(880, 0.4, { delay: 0.06, vol: 0.05 });
      } else if (skill === 3) {
        this.tone(140, 0.35, { vol: 0.16, glide: 45, wet: false });
      } else {
        this.tone(440, 0.25, { vol: 0.06, glide: 660 });
      }
    },

    playKO() {
      this.tone(180, 0.22, { vol: 0.09, glide: 65, wet: false });
    },

    playVictory() {
      [[392, 0], [523.25, 0.12], [659.25, 0.24], [783.99, 0.38], [1046.5, 0.44]].forEach(([f, d]) => {
        this.tone(f, 0.9, { type: 'triangle', delay: d, vol: 0.075 });
      });
    }
  };

  window.addEventListener('pointerdown', () => SoundEngine.ensureCtx(), { once: true });
  window.addEventListener('keydown', () => SoundEngine.ensureCtx(), { once: true });

  // ==================== DOM & CANVAS ====================
  const el = {
    stage: document.getElementById('stage9x16'),
    phasePill: document.getElementById('phasePill'),
    roundPill: document.getElementById('roundPill'),
    alivePill: document.getElementById('alivePill'),
    phaseLabel: document.getElementById('phaseLabel'),
    timerNum: document.getElementById('timerNum'),
    canvas: document.getElementById('arenaCanvas'),
    feedStrip: document.getElementById('feedStrip'),
    liveBadge: document.getElementById('liveBadge'),
    lbList: document.getElementById('lbList'),
    victoryOverlay: document.getElementById('victoryOverlay'),
    victoryWinner: document.getElementById('victoryWinner'),
    victoryStats: document.getElementById('victoryStats'),
    connChip: document.getElementById('connChip'),
    btnNewRound: document.getElementById('btnNewRound'),
    btnStartNow: document.getElementById('btnStartNow'),
    btnToggleBots: document.getElementById('btnToggleBots'),
    btnAddBots: document.getElementById('btnAddBots'),
    btnMuteSound: document.getElementById('btnMuteSound'),
    btnTestSound: document.getElementById('btnTestSound'),
    tiktokUserInput: document.getElementById('tiktokUserInput'),
    btnConnectTikTok: document.getElementById('btnConnectTikTok'),
    btnDisconnectTikTok: document.getElementById('btnDisconnectTikTok'),
    tiktokStatusText: document.getElementById('tiktokStatusText'),
    obsUrlInput: document.getElementById('obsUrlInput')
  };

  if (el.obsUrlInput) {
    el.obsUrlInput.value = `${window.location.origin}${window.location.pathname}?overlay=1`;
  }

  let latestState = null;
  let prevPhase = null;
  const smoothFighters = new Map(); // id -> interpolated state
  const particles = [];
  const shockwaves = [];
  const floatTexts = [];
  const confetti = [];

  const THEME_CANVAS = {
    neon: { ring: '#00f0ff', danger: 'rgba(255, 43, 214, 0.22)', bg: 'rgba(12, 5, 34, 0.72)' },
    gold: { ring: '#ffcc4d', danger: 'rgba(239, 68, 68, 0.24)', bg: 'rgba(26, 18, 4, 0.72)' },
    fire: { ring: '#ff9500', danger: 'rgba(255, 30, 50, 0.28)', bg: 'rgba(30, 6, 3, 0.72)' },
    cyber: { ring: '#38bdf8', danger: 'rgba(239, 68, 68, 0.22)', bg: 'rgba(6, 20, 38, 0.75)' },
    azerbaijan: { ring: '#00b5e2', danger: 'rgba(239, 51, 64, 0.24)', bg: 'rgba(6, 22, 34, 0.72)' }
  };

  function spawnParticles(x, y, color, count = 16) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 50 + Math.random() * 190;
      particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color, size: 2.5 + Math.random() * 3.5 });
    }
  }

  function spawnConfetti() {
    const cols = ['#f5c542', '#38bdf8', '#ff2bd6', '#22c55e', '#ffffff'];
    for (let i = 0; i < 65; i++) {
      confetti.push({
        x: (Math.random() - 0.5) * 760,
        y: -410 - Math.random() * 120,
        vx: (Math.random() - 0.5) * 90,
        vy: 140 + Math.random() * 200,
        size: 5 + Math.random() * 6,
        color: cols[i % cols.length],
        life: 1
      });
    }
  }

  // ==================== SOCKET.IO ====================
  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    if (el.connChip) el.connChip.textContent = 'Canlı Qoşuldu';
  });

  socket.on('tiktok-status', (st) => {
    if (el.tiktokStatusText) {
      el.tiktokStatusText.textContent = st.connected
        ? `🟢 @${st.username} • ${st.viewerCount || 0} izləyici`
        : st.connecting
          ? `⏳ @${st.username} qoşulur...`
          : `⚪ ${st.error || 'Qoşulmayıb'}`;
    }
    if (el.liveBadge) {
      el.liveBadge.textContent = st.connected
        ? `🔴 @${st.username} • ${st.viewerCount || 0}`
        : '● CANLI HAZIR';
    }
  });

  socket.on('arena-fx', (fx) => {
    if (!SoundEngine.muted) SoundEngine.ensureCtx();
    if (fx.type === 'join') {
      SoundEngine.playJoin();
      spawnParticles(fx.x, fx.y, fx.color || '#38bdf8', 10);
    } else if (fx.type === 'battle-start') {
      SoundEngine.playStart();
    } else if (fx.type === 'skill') {
      SoundEngine.playSkill(fx.skill);
      floatTexts.push({ x: fx.x, y: fx.y - 24, text: fx.label, color: fx.color || '#fff', life: 1 });
    } else if (fx.type === 'shockwave') {
      SoundEngine.playSkill(3);
      shockwaves.push({ x: fx.x, y: fx.y, maxR: fx.radius || 165, life: 1 });
      floatTexts.push({ x: fx.x, y: fx.y - 26, text: fx.label || '💥 BOOM!', color: '#f43f5e', life: 1 });
    } else if (fx.type === 'ko') {
      SoundEngine.playKO();
      spawnParticles(fx.x, fx.y, fx.color || '#ef4444', 22);
    } else if (fx.type === 'powerup') {
      SoundEngine.playSkill(2);
      const icons = { speed: '⚡ SÜRƏT!', shield: '🛡️ QALXAN!', heal: '❤️ +30 CAN!', giant: '👑 NƏHƏNG!' };
      floatTexts.push({ x: fx.x, y: fx.y - 20, text: icons[fx.kind] || '⭐ GÜC!', color: '#fde047', life: 1 });
    } else if (fx.type === 'victory') {
      SoundEngine.playVictory();
      spawnConfetti();
    }
  });

  socket.on('arena-state', (state) => {
    latestState = state;
    if (state.soundMuted !== undefined) SoundEngine.muted = !!state.soundMuted;
    if (!SoundEngine.muted) SoundEngine.ensureCtx();

    if (el.stage && state.theme) el.stage.dataset.theme = state.theme;
    document.querySelectorAll('.theme-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.theme === state.theme);
    });

    if (el.roundPill) el.roundPill.textContent = `RAUND ${state.roundNumber}`;
    const aliveCount = (state.fighters || []).filter((f) => f.a).length;
    if (el.alivePill) el.alivePill.textContent = `👥 ${aliveCount} sağ`;

    if (el.timerNum) {
      el.timerNum.textContent = state.timeLeft;
      el.timerNum.classList.toggle('urgent', state.phase === 'battle' && state.timeLeft <= 10);
    }

    if (el.phasePill && el.phaseLabel) {
      if (state.phase === 'lobby') {
        el.phasePill.textContent = '🕒 QOŞULMA';
        el.phaseLabel.textContent = 'Çatda 1 yaz və arenaya düş!';
      } else if (state.phase === 'battle') {
        el.phasePill.textContent = '⚔️ DÖYÜŞ!';
        el.phaseLabel.textContent = 'Rəqəmlərlə idarə et: 1 • 2 • 3 • 4';
      } else {
        el.phasePill.textContent = '👑 FİNAL';
        el.phaseLabel.textContent = 'Qalib elan olundu!';
      }
    }

    if (el.btnToggleBots) {
      el.btnToggleBots.textContent = state.botsEnabled ? '🤖 Bot Rəqiblər: AÇIQ' : '🤖 Bot Rəqiblər: BAĞLI';
    }
    if (el.btnMuteSound) {
      el.btnMuteSound.textContent = state.soundMuted ? '🔇 Səs Bağlıdır' : '🔊 Səs Açıqdır';
    }

    // Feed
    if (el.feedStrip && Array.isArray(state.feed) && state.feed.length > 0) {
      el.feedStrip.innerHTML = `<span class="feed-item">${escapeHtml(state.feed[0].text)}</span>`;
    }

    // Leaderboard
    if (el.lbList) {
      const lb = state.leaderboard || [];
      if (lb.length === 0) {
        el.lbList.innerHTML = '<div class="lb-empty">İlk qalibdən sonra taclar yazılacaq</div>';
      } else {
        el.lbList.innerHTML = lb.slice(0, 3).map((p, idx) => {
          const m = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
          return `<div class="lb-row"><span>${m} ${escapeHtml(p.nickname)}</span><span>👑 ${p.wins} • ${p.score} xal</span></div>`;
        }).join('');
      }
    }

    // Victory overlay
    if (el.victoryOverlay) {
      if (state.phase === 'victory' && state.winner) {
        el.victoryOverlay.classList.remove('hidden');
        el.victoryWinner.textContent = `${state.winner.isBot ? '🤖 ' : ''}${state.winner.nickname}`;
        el.victoryStats.textContent = `${state.winner.kills} Kənarlaşdırma • ${state.winner.hp} HP qaldı`;
      } else {
        el.victoryOverlay.classList.add('hidden');
      }
    }

    // Sync smooth fighters
    const seen = new Set();
    for (const f of (state.fighters || [])) {
      seen.add(f.id);
      const cur = smoothFighters.get(f.id);
      if (!cur) {
        smoothFighters.set(f.id, { ...f, sx: f.x, sy: f.y });
      } else {
        Object.assign(cur, f);
      }
    }
    for (const id of smoothFighters.keys()) {
      if (!seen.has(id)) smoothFighters.delete(id);
    }

    prevPhase = state.phase;
  });

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ==================== 60 FPS CANVAS RENDERER ====================
  let lastFrame = performance.now();
  function renderLoop(now) {
    requestAnimationFrame(renderLoop);
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;

    const canvas = el.canvas;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const state = latestState;
    if (!state) return;

    const maxR = state.maxRadius || 390;
    const scale = (Math.min(w, h) * 0.47) / maxR;
    ctx.translate(w * 0.5, h * 0.5);
    ctx.scale(scale, scale);

    const pal = THEME_CANVAS[state.theme] || THEME_CANVAS.neon;

    // Outer stadium dark circle + danger zone ring
    ctx.beginPath();
    ctx.arc(0, 0, maxR, 0, Math.PI * 2);
    ctx.fillStyle = pal.danger;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.5)';
    ctx.stroke();

    // Safe Zone inner circle
    const zr = state.zoneRadius || maxR;
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, zr, 0, Math.PI * 2);
    ctx.fillStyle = pal.bg;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = pal.ring;
    ctx.shadowColor = pal.ring;
    ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.restore();

    // Subtle concentric arena rings
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 2;
    [0.33, 0.66].forEach((f) => {
      if (zr * f > 18) {
        ctx.beginPath();
        ctx.arc(0, 0, zr * f, 0, Math.PI * 2);
        ctx.stroke();
      }
    });

    // Powerups
    const pIcons = { speed: '⚡', shield: '🛡️', heal: '❤️', giant: '👑' };
    for (const p of (state.powerups || [])) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(250, 204, 21, 0.22)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fde047';
      ctx.stroke();
      ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(pIcons[p.kind] || '⭐', p.x, p.y + 1);
    }

    // Hazards (spinning blades)
    for (const hz of (state.hazards || [])) {
      ctx.save();
      ctx.translate(hz.x, hz.y);
      ctx.rotate(now * 0.008);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        ctx.lineTo(Math.cos(a) * (hz.r + 5), Math.sin(a) * (hz.r + 5));
        const a2 = a + Math.PI / 6;
        ctx.lineTo(Math.cos(a2) * (hz.r * 0.55), Math.sin(a2) * (hz.r * 0.55));
      }
      ctx.closePath();
      ctx.fillStyle = '#ef4444';
      ctx.shadowColor = '#ef4444';
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.restore();
    }

    // Shockwaves
    for (let i = shockwaves.length - 1; i >= 0; i--) {
      const sw = shockwaves[i];
      sw.life -= dt * 2.1;
      if (sw.life <= 0) { shockwaves.splice(i, 1); continue; }
      const rNow = sw.maxR * (1 - sw.life);
      ctx.beginPath();
      ctx.arc(sw.x, sw.y, rNow, 0, Math.PI * 2);
      ctx.lineWidth = 5 * sw.life;
      ctx.strokeStyle = `rgba(244, 63, 94, ${sw.life})`;
      ctx.stroke();
    }

    // Fighters
    for (const f of smoothFighters.values()) {
      if (!f.a) continue;
      f.sx += (f.x - f.sx) * 0.38;
      f.sy += (f.y - f.sy) * 0.38;

      ctx.save();
      // Giant or Dash aura
      if (f.gi) {
        ctx.beginPath();
        ctx.arc(f.sx, f.sy, f.r + 7, 0, Math.PI * 2);
        ctx.strokeStyle = '#f5c542';
        ctx.lineWidth = 4;
        ctx.stroke();
      } else if (f.da) {
        ctx.beginPath();
        ctx.arc(f.sx, f.sy, f.r + 5, 0, Math.PI * 2);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      // Main circle
      ctx.beginPath();
      ctx.arc(f.sx, f.sy, f.r, 0, Math.PI * 2);
      ctx.fillStyle = f.c;
      ctx.fill();
      ctx.lineWidth = f.b ? 2 : 3.5;
      ctx.strokeStyle = f.b ? 'rgba(255,255,255,0.45)' : '#ffffff';
      ctx.stroke();

      // HP arc around fighter
      const hpFrac = Math.max(0, Math.min(1, f.hp / 100));
      ctx.beginPath();
      ctx.arc(f.sx, f.sy, f.r + 2.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * hpFrac);
      ctx.lineWidth = 3;
      ctx.strokeStyle = hpFrac > 0.5 ? '#22c55e' : hpFrac > 0.25 ? '#f59e0b' : '#ef4444';
      ctx.stroke();

      // Shield bubble
      if (f.sh) {
        ctx.beginPath();
        ctx.arc(f.sx, f.sy, f.r + 8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(34, 197, 94, 0.16)';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#4ade80';
        ctx.stroke();
      }

      // Initial inside circle
      ctx.fillStyle = '#fff';
      ctx.font = `900 ${Math.round(f.r * 0.85)}px Montserrat, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const initChar = f.cr > 0 ? '👑' : (f.n || '?').slice(0, 1).toUpperCase();
      ctx.fillText(initChar, f.sx, f.sy + 1);

      // Name pill below fighter
      const label = (f.b ? '' : '★ ') + f.n;
      ctx.font = `700 ${f.b ? 12 : 14}px Inter, sans-serif`;
      const tw = ctx.measureText(label).width + 10;
      const py = f.sy + f.r + 12;
      ctx.fillStyle = f.b ? 'rgba(10, 14, 30, 0.72)' : 'rgba(2, 132, 199, 0.88)';
      ctx.beginPath();
      ctx.roundRect(f.sx - tw / 2, py - 8, tw, 17, 6);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(label, f.sx, py + 1);
      ctx.restore();
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt * 1.9;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Floating skill text
    for (let i = floatTexts.length - 1; i >= 0; i--) {
      const ft = floatTexts[i];
      ft.y -= 42 * dt;
      ft.life -= dt * 1.1;
      if (ft.life <= 0) { floatTexts.splice(i, 1); continue; }
      ctx.globalAlpha = ft.life;
      ctx.font = '900 17px Montserrat, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = ft.color;
      ctx.fillText(ft.text, ft.x, ft.y);
      ctx.globalAlpha = 1;
    }

    // Confetti
    for (let i = confetti.length - 1; i >= 0; i--) {
      const c = confetti[i];
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.life -= dt * 0.25;
      if (c.life <= 0 || c.y > 420) { confetti.splice(i, 1); continue; }
      ctx.fillStyle = c.color;
      ctx.fillRect(c.x, c.y, c.size, c.size * 1.4);
    }
  }
  requestAnimationFrame(renderLoop);

  // ==================== HOST CONTROLS ====================
  if (el.btnNewRound) el.btnNewRound.addEventListener('click', () => socket.emit('new-round'));
  if (el.btnStartNow) el.btnStartNow.addEventListener('click', () => socket.emit('start-battle-now'));
  if (el.btnToggleBots) {
    el.btnToggleBots.addEventListener('click', () => {
      const next = !(latestState && latestState.botsEnabled);
      socket.emit('toggle-bots', { enabled: next });
    });
  }
  if (el.btnAddBots) el.btnAddBots.addEventListener('click', () => socket.emit('add-bots', { count: 5 }));
  if (el.btnMuteSound) {
    el.btnMuteSound.addEventListener('click', () => {
      SoundEngine.muted = !SoundEngine.muted;
      socket.emit('toggle-sound', { muted: SoundEngine.muted });
    });
  }
  if (el.btnTestSound) {
    el.btnTestSound.addEventListener('click', () => {
      SoundEngine.ensureCtx();
      SoundEngine.playVictory();
    });
  }
  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => socket.emit('set-theme', { theme: btn.dataset.theme }));
  });
  if (el.btnConnectTikTok) {
    el.btnConnectTikTok.addEventListener('click', () => {
      socket.emit('connect-tiktok', { username: el.tiktokUserInput.value.trim() });
    });
  }
  if (el.btnDisconnectTikTok) {
    el.btnDisconnectTikTok.addEventListener('click', () => socket.emit('disconnect-tiktok'));
  }
  document.querySelectorAll('[data-cmd]').forEach((btn) => {
    btn.addEventListener('click', () => {
      socket.emit('manual-cmd', { nickname: 'Aparıcı_Test', cmd: btn.dataset.cmd });
    });
  });
  const btnCopy = document.getElementById('btnCopyObs');
  if (btnCopy && el.obsUrlInput) {
    btnCopy.addEventListener('click', () => {
      navigator.clipboard?.writeText(el.obsUrlInput.value).catch(() => {});
      btnCopy.textContent = '✅ Kopyalandı!';
      setTimeout(() => { btnCopy.textContent = '📋 Kopyala'; }, 1500);
    });
  }
})();
