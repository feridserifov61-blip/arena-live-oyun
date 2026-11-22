const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { TikTokLiveConnection, WebcastEvent, ControlEvent } = require('tiktok-live-connector');

const PORT = Number(process.env.PORT) || 3001;
const DEFAULT_TIKTOK_USER = (process.env.TIKTOK_USER || 'bakuremixlab').trim().replace(/^@+/, '').toLowerCase();
const PUBLIC_DIR = path.join(__dirname, 'public');
const SETTINGS_PATH = path.join(__dirname, 'settings.json');

const THEMES = ['neon', 'gold', 'fire', 'cyber', 'azerbaijan'];
const BOT_NAMES = [
  'Tural', 'Aynur', 'Rəşad', 'Günel', 'Kamran', 'Nigar', 'Elvin', 'Səbinə',
  'Orxan', 'Leyla', 'Fərid', 'Zəhra', 'Vüsal', 'Nərmin', 'Babək', 'Aysel',
  'Emin', 'Ülviyyə', 'Cavid', 'Mədinə'
];
const FIGHTER_COLORS = [
  '#38bdf8', '#f43f5e', '#a855f7', '#22c55e', '#f59e0b',
  '#ec4899', '#14b8a6', '#6366f1', '#fb923c', '#84cc16'
];

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveSettings(patch) {
  try {
    const next = { ...loadSettings(), ...patch };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  } catch (_) {}
}

const initialSettings = loadSettings();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// ==================== ARENA STATE ====================
const ARENA_MAX_R = 390;
const ARENA_MIN_R = 58;
const MAX_FIGHTERS = 60;
const TICK_MS = 50; // 20 Hz simulation

const game = {
  roundNumber: 1,
  phase: 'lobby', // 'lobby' | 'battle' | 'victory'
  lobbyDuration: 16,
  battleDuration: 62,
  victoryDuration: 7,
  phaseStartedAt: Date.now(),
  timeLeft: 16,
  zoneRadius: ARENA_MAX_R,
  botsEnabled: initialSettings.botsEnabled !== undefined ? !!initialSettings.botsEnabled : true,
  soundMuted: false,
  theme: THEMES.includes(initialSettings.theme) ? initialSettings.theme : 'neon',
  fighters: new Map(), // id -> fighter
  powerups: [],
  hazards: [],
  feed: [],
  leaderboard: new Map(), // uniqueId -> { uniqueId, nickname, wins, score }
  eliminatedOrder: [],
  winner: null,
  lastBroadcastAt: 0,
  nextId: 1
};

const tiktok = {
  username: DEFAULT_TIKTOK_USER,
  conn: null,
  connecting: false,
  connected: false,
  viewerCount: 0,
  error: '',
  reconnectTimer: null
};

app.get('/healthz', (_req, res) => {
  const alive = Array.from(game.fighters.values()).filter((f) => f.alive).length;
  res.status(200).json({ ok: true, connected: tiktok.connected, phase: game.phase, alive });
});

function pickColor(seedStr) {
  let h = 0;
  for (let i = 0; i < seedStr.length; i++) {
    h = (h * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  return FIGHTER_COLORS[h % FIGHTER_COLORS.length];
}

function pushFeed(text, kind = 'info') {
  game.feed.unshift({ id: game.nextId++, text, kind, ts: Date.now() });
  if (game.feed.length > 6) game.feed.length = 6;
}

function emitFx(fx) {
  io.emit('arena-fx', fx);
}

function awardLeaderboard(uniqueId, nickname, scoreDelta, winDelta = 0) {
  if (!uniqueId || uniqueId.startsWith('bot_')) return;
  const prev = game.leaderboard.get(uniqueId) || { uniqueId, nickname, wins: 0, score: 0 };
  prev.score += scoreDelta;
  prev.wins += winDelta;
  prev.nickname = nickname || prev.nickname;
  game.leaderboard.set(uniqueId, prev);
}

function spawnFighter(id, nickname, isBot = false) {
  if (game.fighters.has(id)) return game.fighters.get(id);
  if (game.fighters.size >= MAX_FIGHTERS) return null;

  const angle = Math.random() * Math.PI * 2;
  const dist = Math.random() * Math.max(40, game.zoneRadius * 0.68);
  const speed = 135 + Math.random() * 45;
  const moveAngle = Math.random() * Math.PI * 2;
  const lb = game.leaderboard.get(id);

  const f = {
    id,
    nickname: String(nickname || id).slice(0, 18),
    isBot,
    x: Math.cos(angle) * dist,
    y: Math.sin(angle) * dist,
    vx: Math.cos(moveAngle) * speed,
    vy: Math.sin(moveAngle) * speed,
    radius: isBot ? 18 : 22,
    hp: isBot ? 85 : 100,
    maxHp: 100,
    alive: true,
    color: pickColor(id),
    crowns: lb ? lb.wins : 0,
    shieldUntil: 0,
    dashUntil: 0,
    giantUntil: 0,
    safeUntil: 0,
    cd1: 0,
    cd2: 0,
    cd3: 0,
    cd4: 0,
    kills: 0,
    likesAccum: 0,
    lastHitBy: null,
    lastHitAt: 0
  };
  game.fighters.set(id, f);
  return f;
}

function fillBots(targetCount = 14) {
  const used = new Set(Array.from(game.fighters.values()).map((f) => f.nickname));
  const pool = BOT_NAMES.filter((n) => !used.has(n));
  let idx = 0;
  while (game.fighters.size < targetCount && idx < pool.length) {
    const name = pool[idx++];
    spawnFighter(`bot_${idx}_${Date.now()}`, name, true);
  }
}

function startLobby() {
  game.phase = 'lobby';
  game.phaseStartedAt = Date.now();
  game.timeLeft = game.lobbyDuration;
  game.zoneRadius = ARENA_MAX_R;
  game.fighters.clear();
  game.powerups = [];
  game.hazards = [];
  game.eliminatedOrder = [];
  game.winner = null;
  game.feed = [];
  pushFeed(`Raund ${game.roundNumber} başladı! Çatda 1 yaz və döyüşə qoşul!`, 'start');
  broadcastSnapshot(true);
}

function startBattle() {
  if (game.phase === 'battle') return;
  if (game.botsEnabled && game.fighters.size < 14) {
    fillBots(14);
  }
  // Ensure at least 4 fighters exist so battle never ends immediately
  if (game.fighters.size < 4) {
    fillBots(6);
  }
  game.phase = 'battle';
  game.phaseStartedAt = Date.now();
  game.timeLeft = game.battleDuration;
  game.zoneRadius = ARENA_MAX_R;
  game.hazards = [
    { id: 1, angle: 0, dist: 165, speed: 1.35, radius: 18 },
    { id: 2, angle: Math.PI, dist: 165, speed: 1.35, radius: 18 }
  ];
  pushFeed('⚔️ Döyüş başladı! 1=Hücum • 2=Qalxan • 3=Zərbə • 4=Mərkəz', 'battle');
  emitFx({ type: 'battle-start' });
  broadcastSnapshot(true);
}

function finishBattle(survivors) {
  if (game.phase !== 'battle') return;
  game.phase = 'victory';
  game.phaseStartedAt = Date.now();
  game.timeLeft = game.victoryDuration;

  const ranked = [...survivors].sort((a, b) => b.hp - a.hp || b.kills - a.kills);
  const champ = ranked[0] || game.eliminatedOrder[game.eliminatedOrder.length - 1] || null;
  const second = ranked[1] || game.eliminatedOrder[game.eliminatedOrder.length - 2] || null;
  const third = ranked[2] || game.eliminatedOrder[game.eliminatedOrder.length - 3] || null;

  if (champ) {
    awardLeaderboard(champ.id, champ.nickname, 300, 1);
    champ.crowns = (game.leaderboard.get(champ.id)?.wins) || champ.crowns;
  }
  if (second && second !== champ) awardLeaderboard(second.id, second.nickname, 150, 0);
  if (third && third !== champ && third !== second) awardLeaderboard(third.id, third.nickname, 75, 0);

  game.winner = champ
    ? { id: champ.id, nickname: champ.nickname, isBot: champ.isBot, kills: champ.kills, hp: Math.round(champ.hp) }
    : null;

  if (champ) {
    pushFeed(`👑 ARENA KRALI: ${champ.nickname}!`, 'win');
  }
  emitFx({ type: 'victory', winner: game.winner });
  broadcastSnapshot(true);
}

function findNearestEnemy(self) {
  let best = null;
  let bestD2 = Infinity;
  for (const other of game.fighters.values()) {
    if (!other.alive || other.id === self.id) continue;
    const dx = other.x - self.x;
    const dy = other.y - self.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = other;
    }
  }
  return best;
}

function triggerNumberSkill(fighter, num, now) {
  if (!fighter || !fighter.alive || game.phase !== 'battle') return;

  if (num === 1) {
    if (now < fighter.cd1) return;
    fighter.cd1 = now + 4500;
    fighter.dashUntil = now + 1800;
    const target = findNearestEnemy(fighter);
    const ang = target
      ? Math.atan2(target.y - fighter.y, target.x - fighter.x)
      : Math.atan2(-fighter.y, -fighter.x);
    fighter.vx += Math.cos(ang) * 280;
    fighter.vy += Math.sin(ang) * 280;
    emitFx({ type: 'skill', skill: 1, x: fighter.x, y: fighter.y, label: '⚡ HÜCUM!', color: '#38bdf8', nickname: fighter.nickname });
    return;
  }

  if (num === 2) {
    if (now < fighter.cd2) return;
    fighter.cd2 = now + 6500;
    fighter.shieldUntil = now + 3500;
    fighter.hp = Math.min(fighter.maxHp, fighter.hp + 8);
    emitFx({ type: 'skill', skill: 2, x: fighter.x, y: fighter.y, label: '🛡️ QALXAN!', color: '#22c55e', nickname: fighter.nickname });
    return;
  }

  if (num === 3) {
    if (now < fighter.cd3) return;
    fighter.cd3 = now + 7500;
    const blastR = 175;
    let pushed = 0;
    for (const other of game.fighters.values()) {
      if (!other.alive || other.id === fighter.id) continue;
      const dx = other.x - fighter.x;
      const dy = other.y - fighter.y;
      const d = Math.hypot(dx, dy);
      if (d > 0 && d < blastR) {
        const shieldMul = now < other.shieldUntil ? 0.35 : 1;
        const force = (1 - d / blastR) * 430 * shieldMul;
        other.vx += (dx / d) * force;
        other.vy += (dy / d) * force;
        other.lastHitBy = fighter.id;
        other.lastHitAt = now;
        pushed++;
      }
    }
    emitFx({ type: 'shockwave', x: fighter.x, y: fighter.y, radius: blastR, label: pushed > 0 ? '💥 BOOM!' : '💥 ZƏRBƏ!', nickname: fighter.nickname });
    return;
  }

  if (num === 4) {
    if (now < fighter.cd4) return;
    fighter.cd4 = now + 6000;
    fighter.safeUntil = now + 1200;
    const d = Math.hypot(fighter.x, fighter.y);
    if (d > 10) {
      fighter.vx = (-fighter.x / d) * 320;
      fighter.vy = (-fighter.y / d) * 320;
    } else {
      const ang = Math.random() * Math.PI * 2;
      fighter.vx = Math.cos(ang) * 180;
      fighter.vy = Math.sin(ang) * 180;
    }
    emitFx({ type: 'skill', skill: 4, x: fighter.x, y: fighter.y, label: '🧲 MƏRKƏZ!', color: '#f59e0b', nickname: fighter.nickname });
  }
}

function parseNumberCommand(rawText) {
  const clean = String(rawText || '').trim().toLowerCase();
  if (!clean) return null;
  if (/^[1¹]\b|^1[!?.]*$|^(go|oyna|qat[ıi]l|\+|suret|hucum)$/i.test(clean)) return 1;
  if (/^[2²]\b|^2[!?.]*$|^(qalxan|shield|qoru)$/i.test(clean)) return 2;
  if (/^[3³]\b|^3[!?.]*$|^(zerbe|vur|bomba|boom)$/i.test(clean)) return 3;
  if (/^[4⁴]\b|^4[!?.]*$|^(merkez|mərkəz|kac|qac|qaç)$/i.test(clean)) return 4;
  return null;
}

function handleViewerChat({ uniqueId, nickname, comment }) {
  const now = Date.now();
  const cmd = parseNumberCommand(comment);
  const fighter = game.fighters.get(uniqueId);
  const canLateJoin = game.phase === 'lobby' || (game.phase === 'battle' && (now - game.phaseStartedAt) < 18000);

  if (!fighter) {
    if (cmd !== null || game.phase === 'lobby') {
      const created = spawnFighter(uniqueId, nickname, false);
      if (created) {
        pushFeed(`⚔️ ${created.nickname} arenaya düşdü!`, 'join');
        emitFx({ type: 'join', x: created.x, y: created.y, nickname: created.nickname, color: created.color });
        if (cmd && cmd !== 1 && game.phase === 'battle') {
          triggerNumberSkill(created, cmd, now);
        }
        broadcastSnapshot(true);
      }
    } else if (canLateJoin) {
      const created = spawnFighter(uniqueId, nickname, false);
      if (created) {
        pushFeed(`⚔️ ${created.nickname} arenaya qoşuldu!`, 'join');
        emitFx({ type: 'join', x: created.x, y: created.y, nickname: created.nickname, color: created.color });
      }
    }
    return;
  }

  fighter.nickname = String(nickname || fighter.nickname).slice(0, 18);
  if (cmd !== null) {
    triggerNumberSkill(fighter, cmd, now);
  }
}

function handleViewerLike({ uniqueId, nickname, count }) {
  const now = Date.now();
  let fighter = game.fighters.get(uniqueId);
  if (!fighter && game.phase === 'lobby') {
    fighter = spawnFighter(uniqueId, nickname, false);
    if (fighter) {
      pushFeed(`❤️ ${fighter.nickname} Like ilə qoşuldu!`, 'join');
    }
  }
  if (!fighter || !fighter.alive) return;

  fighter.likesAccum += Math.max(1, Number(count) || 1);
  if (fighter.likesAccum >= 6) {
    fighter.likesAccum -= 6;
    fighter.radius = Math.min(34, fighter.radius + 1.2);
    fighter.hp = Math.min(fighter.maxHp, fighter.hp + 6);
    emitFx({ type: 'skill', skill: 0, x: fighter.x, y: fighter.y, label: '❤️ +GÜC!', color: '#f43f5e', nickname: fighter.nickname });
  }
  if (game.phase === 'battle' && now > fighter.cd1 && Math.random() < 0.25) {
    triggerNumberSkill(fighter, 1, now);
  }
}

function handleViewerGift({ uniqueId, nickname, giftName, repeatCount }) {
  const now = Date.now();
  let fighter = game.fighters.get(uniqueId);
  if (!fighter && (game.phase === 'lobby' || game.phase === 'battle')) {
    fighter = spawnFighter(uniqueId, nickname, false);
  }
  if (!fighter || !fighter.alive) return;

  fighter.radius = Math.min(38, fighter.radius + 5);
  fighter.hp = fighter.maxHp;
  fighter.shieldUntil = now + 5000;
  fighter.giantUntil = now + 8000;
  pushFeed(`🎁 ${fighter.nickname} (${giftName} x${repeatCount}) QIZIL GÜC aldı!`, 'gift');
  triggerNumberSkill(fighter, 3, now);
}

// ==================== PHYSICS LOOP ====================
function stepPhysics() {
  const now = Date.now();
  const dt = TICK_MS / 1000;

  if (game.phase === 'lobby') {
    const elapsed = (now - game.phaseStartedAt) / 1000;
    game.timeLeft = Math.max(0, Math.ceil(game.lobbyDuration - elapsed));
    // Gentle idle floating in lobby
    for (const f of game.fighters.values()) {
      f.x += f.vx * 0.25 * dt;
      f.y += f.vy * 0.25 * dt;
      const d = Math.hypot(f.x, f.y);
      if (d > game.zoneRadius - f.radius - 10) {
        const ang = Math.atan2(f.y, f.x);
        f.vx = -Math.abs(f.vx) * Math.cos(ang) + (Math.random() - 0.5) * 40;
        f.vy = -Math.abs(f.vy) * Math.sin(ang) + (Math.random() - 0.5) * 40;
        f.x = Math.cos(ang) * (game.zoneRadius - f.radius - 12);
        f.y = Math.sin(ang) * (game.zoneRadius - f.radius - 12);
      }
    }
    if (elapsed >= game.lobbyDuration) {
      startBattle();
    }
    broadcastSnapshot(false);
    return;
  }

  if (game.phase === 'victory') {
    const elapsed = (now - game.phaseStartedAt) / 1000;
    game.timeLeft = Math.max(0, Math.ceil(game.victoryDuration - elapsed));
    if (elapsed >= game.victoryDuration) {
      game.roundNumber += 1;
      startLobby();
    }
    broadcastSnapshot(false);
    return;
  }

  // BATTLE PHASE
  const elapsed = (now - game.phaseStartedAt) / 1000;
  game.timeLeft = Math.max(0, Math.ceil(game.battleDuration - elapsed));
  const progress = Math.min(1, elapsed / game.battleDuration);
  game.zoneRadius = ARENA_MAX_R - (ARENA_MAX_R - ARENA_MIN_R) * progress;

  // Spawn powerups occasionally
  if (game.powerups.length < 3 && Math.random() < 0.025) {
    const kinds = ['speed', 'shield', 'heal', 'giant'];
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * Math.max(20, game.zoneRadius * 0.7);
    game.powerups.push({
      id: game.nextId++,
      kind,
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      radius: 16
    });
  }

  // Update hazards (spinning blades inside safe zone)
  const hazardOrbit = Math.min(165, Math.max(45, game.zoneRadius * 0.58));
  for (const h of game.hazards) {
    h.angle += h.speed * dt;
    h.dist = hazardOrbit;
    h.x = Math.cos(h.angle) * h.dist;
    h.y = Math.sin(h.angle) * h.dist;
  }

  const aliveList = Array.from(game.fighters.values()).filter((f) => f.alive);

  // Fighter AI / steering + movement
  for (const f of aliveList) {
    const dCenter = Math.hypot(f.x, f.y);
    // Keep inside safe zone bias if near edge
    if (dCenter > game.zoneRadius * 0.72) {
      const pull = f.isBot ? 180 : 120;
      f.vx += (-f.x / (dCenter || 1)) * pull * dt;
      f.vy += (-f.y / (dCenter || 1)) * pull * dt;
    } else {
      // Slight steering toward nearest fighter
      const target = findNearestEnemy(f);
      if (target) {
        const dx = target.x - f.x;
        const dy = target.y - f.y;
        const d = Math.hypot(dx, dy) || 1;
        const steer = f.isBot ? 95 : 125;
        f.vx += (dx / d) * steer * dt;
        f.vy += (dy / d) * steer * dt;
      }
      // Bot occasional random skill
      if (f.isBot && Math.random() < 0.008) {
        triggerNumberSkill(f, Math.random() < 0.65 ? 1 : 2, now);
      }
    }

    // Damping & speed cap
    f.vx *= 0.985;
    f.vy *= 0.985;
    const maxSpd = now < f.dashUntil ? 370 : 210;
    const minSpd = 65;
    const spd = Math.hypot(f.vx, f.vy);
    if (spd > maxSpd) {
      f.vx = (f.vx / spd) * maxSpd;
      f.vy = (f.vy / spd) * maxSpd;
    } else if (spd < minSpd) {
      const a = Math.random() * Math.PI * 2;
      f.vx += Math.cos(a) * 55;
      f.vy += Math.sin(a) * 55;
    }

    f.x += f.vx * dt;
    f.y += f.vy * dt;

    // Hard outer stadium bounce (at ARENA_MAX_R)
    const dAfter = Math.hypot(f.x, f.y);
    if (dAfter > ARENA_MAX_R - f.radius) {
      const nx = f.x / (dAfter || 1);
      const ny = f.y / (dAfter || 1);
      f.x = nx * (ARENA_MAX_R - f.radius);
      f.y = ny * (ARENA_MAX_R - f.radius);
      const dot = f.vx * nx + f.vy * ny;
      if (dot > 0) {
        f.vx -= 1.8 * dot * nx;
        f.vy -= 1.8 * dot * ny;
      }
    }
  }

  // Circle-circle elastic collisions
  for (let i = 0; i < aliveList.length; i++) {
    const a = aliveList[i];
    for (let j = i + 1; j < aliveList.length; j++) {
      const b = aliveList[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy);
      const minD = a.radius + b.radius;
      if (dist > 0 && dist < minD) {
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = (minD - dist) * 0.5;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;

        const rvx = b.vx - a.vx;
        const rvy = b.vy - a.vy;
        const velAlongNormal = rvx * nx + rvy * ny;
        if (velAlongNormal < 0) {
          const massA = a.radius * a.radius * (now < a.giantUntil ? 1.8 : 1) * (now < a.dashUntil ? 1.5 : 1);
          const massB = b.radius * b.radius * (now < b.giantUntil ? 1.8 : 1) * (now < b.dashUntil ? 1.5 : 1);
          const restitution = 1.08;
          const jImp = (-(1 + restitution) * velAlongNormal) / (1 / massA + 1 / massB);
          const ix = jImp * nx;
          const iy = jImp * ny;

          if (now >= a.shieldUntil) {
            a.vx -= ix / massA;
            a.vy -= iy / massA;
          }
          if (now >= b.shieldUntil) {
            b.vx += ix / massB;
            b.vy += iy / massB;
          }
          a.lastHitBy = b.id;
          a.lastHitAt = now;
          b.lastHitBy = a.id;
          b.lastHitAt = now;

          // Contact damage if dashing or giant
          if (now < a.dashUntil && now >= b.shieldUntil) b.hp -= 4.5;
          if (now < b.dashUntil && now >= a.shieldUntil) a.hp -= 4.5;
          if (now < a.giantUntil && now >= b.shieldUntil) b.hp -= 3.5;
          if (now < b.giantUntil && now >= a.shieldUntil) a.hp -= 3.5;
        }
      }
    }
  }

  // Powerups collection
  for (let pIdx = game.powerups.length - 1; pIdx >= 0; pIdx--) {
    const p = game.powerups[pIdx];
    for (const f of aliveList) {
      if (Math.hypot(f.x - p.x, f.y - p.y) < f.radius + p.radius) {
        if (p.kind === 'speed') {
          f.dashUntil = now + 3500;
          f.cd1 = 0;
        } else if (p.kind === 'shield') {
          f.shieldUntil = now + 4000;
          f.cd2 = 0;
        } else if (p.kind === 'heal') {
          f.hp = Math.min(f.maxHp, f.hp + 30);
        } else if (p.kind === 'giant') {
          f.giantUntil = now + 6000;
          f.radius = Math.min(34, f.radius + 3);
        }
        emitFx({ type: 'powerup', x: p.x, y: p.y, kind: p.kind, nickname: f.nickname });
        game.powerups.splice(pIdx, 1);
        break;
      }
    }
  }

  // Hazard blades + Safe Zone burn + Elimination
  const nextAlive = [];
  for (const f of aliveList) {
    if (now >= f.shieldUntil && now >= f.safeUntil) {
      for (const h of game.hazards) {
        const dx = f.x - h.x;
        const dy = f.y - h.y;
        const d = Math.hypot(dx, dy);
        if (d > 0 && d < f.radius + h.radius) {
          f.hp -= 12;
          f.vx += (dx / d) * 260;
          f.vy += (dy / d) * 260;
        }
      }
    }

    const dZone = Math.hypot(f.x, f.y);
    if (dZone > game.zoneRadius - f.radius * 0.25 && now >= f.safeUntil) {
      const burn = now < f.shieldUntil ? 12 * dt : 42 * dt;
      f.hp -= burn;
    }

    if (f.hp <= 0) {
      f.hp = 0;
      f.alive = false;
      game.eliminatedOrder.push(f);
      let msg = `💀 ${f.nickname} arenadan çıxdı!`;
      if (f.lastHitBy && now - f.lastHitAt < 4500) {
        const killer = game.fighters.get(f.lastHitBy);
        if (killer) {
          killer.kills += 1;
          awardLeaderboard(killer.id, killer.nickname, 50, 0);
          msg = `🔥 ${killer.nickname} → ${f.nickname}-nı atdı!`;
        }
      }
      pushFeed(msg, 'ko');
      emitFx({ type: 'ko', x: f.x, y: f.y, color: f.color, nickname: f.nickname });
    } else {
      nextAlive.push(f);
    }
  }

  if (nextAlive.length <= 1 || elapsed >= game.battleDuration) {
    finishBattle(nextAlive);
    return;
  }

  broadcastSnapshot(false);
}

function buildSnapshot(forceFull = false) {
  const now = Date.now();
  const fighters = Array.from(game.fighters.values()).map((f) => ({
    id: f.id,
    n: f.nickname,
    b: f.isBot ? 1 : 0,
    x: Math.round(f.x),
    y: Math.round(f.y),
    r: Math.round(f.radius),
    hp: Math.round(f.hp),
    a: f.alive ? 1 : 0,
    c: f.color,
    cr: f.crowns,
    sh: now < f.shieldUntil ? 1 : 0,
    da: now < f.dashUntil ? 1 : 0,
    gi: now < f.giantUntil ? 1 : 0
  }));

  return {
    roundNumber: game.roundNumber,
    phase: game.phase,
    timeLeft: game.timeLeft,
    zoneRadius: Math.round(game.zoneRadius),
    maxRadius: ARENA_MAX_R,
    botsEnabled: game.botsEnabled,
    soundMuted: game.soundMuted,
    theme: game.theme,
    fighters,
    powerups: game.powerups,
    hazards: game.hazards.map((h) => ({ x: Math.round(h.x || 0), y: Math.round(h.y || 0), r: h.radius })),
    feed: game.feed,
    winner: game.winner,
    leaderboard: Array.from(game.leaderboard.values())
      .sort((a, b) => b.wins - a.wins || b.score - a.score)
      .slice(0, 5),
    full: forceFull
  };
}

function broadcastSnapshot(force = false) {
  const now = Date.now();
  if (!force && now - game.lastBroadcastAt < TICK_MS - 5) return;
  game.lastBroadcastAt = now;
  io.emit('arena-state', buildSnapshot(force));
}

// ==================== TIKTOK LIVE CONNECTOR ====================
function emitTikTokStatus() {
  io.emit('tiktok-status', {
    connecting: tiktok.connecting,
    connected: tiktok.connected,
    username: tiktok.username,
    viewerCount: tiktok.viewerCount,
    error: tiktok.error
  });
}

function scheduleReconnect(delayMs = 6000) {
  clearTimeout(tiktok.reconnectTimer);
  if (!tiktok.username) return;
  tiktok.reconnectTimer = setTimeout(() => {
    if (!tiktok.connected && !tiktok.connecting) {
      connectTikTok(tiktok.username, false);
    }
  }, delayMs);
}

async function disconnectTikTok(clearUser = false) {
  clearTimeout(tiktok.reconnectTimer);
  const old = tiktok.conn;
  tiktok.conn = null;
  tiktok.connecting = false;
  tiktok.connected = false;
  tiktok.viewerCount = 0;
  if (clearUser) tiktok.username = '';
  if (old) {
    try { await old.disconnect(); } catch (_) {}
  }
  emitTikTokStatus();
}

async function connectTikTok(rawUsername, isManual = false) {
  const clean = (rawUsername || '').trim().replace(/^@+/, '').toLowerCase();
  if (!clean) {
    tiktok.error = 'İstifadəçi adı boşdur';
    emitTikTokStatus();
    return;
  }

  await disconnectTikTok(false);
  tiktok.username = clean;
  tiktok.connecting = true;
  tiktok.error = '';
  emitTikTokStatus();

  console.log(`[TikTok] @${clean} canlı yayımına qoşulur...`);
  const conn = new TikTokLiveConnection(clean, {
    processInitialData: false,
    enableExtendedGiftInfo: false,
    requestPollingIntervalMs: 1200
  });
  tiktok.conn = conn;

  conn.on(WebcastEvent.CHAT, (data) => {
    if (tiktok.conn !== conn) return;
    const uniqueId = String(data.user?.displayId || data.user?.uniqueId || data.user?.id || data.user?.userId || data.uniqueId || 'viewer');
    const nickname = String(data.user?.nickname || uniqueId);
    const comment = String(data.content ?? data.comment ?? '').trim();
    if (!comment) return;
    handleViewerChat({ uniqueId, nickname, comment });
  });

  conn.on(WebcastEvent.LIKE, (data) => {
    if (tiktok.conn !== conn) return;
    const uniqueId = String(data.user?.displayId || data.user?.uniqueId || data.user?.id || 'viewer');
    const nickname = String(data.user?.nickname || uniqueId);
    const count = Number(data.count ?? data.likeCount ?? 1);
    handleViewerLike({ uniqueId, nickname, count });
  });

  conn.on(WebcastEvent.GIFT, (data) => {
    if (tiktok.conn !== conn) return;
    const giftType = data.gift?.type ?? data.giftDetails?.giftType;
    if (giftType === 1 && !data.repeatEnd) return;
    const uniqueId = String(data.user?.displayId || data.user?.uniqueId || data.user?.id || 'viewer');
    const nickname = String(data.user?.nickname || uniqueId);
    const giftName = data.gift?.name || data.giftDetails?.giftName || `Hədiyyə #${data.giftId}`;
    const repeatCount = Number(data.repeatCount || 1);
    handleViewerGift({ uniqueId, nickname, giftName, repeatCount });
  });

  conn.on(WebcastEvent.ROOM_USER, (data) => {
    if (tiktok.conn !== conn) return;
    const rawVc = data.viewerCount ?? data.total ?? data.totalUser;
    if (rawVc !== undefined && rawVc !== null && rawVc !== '') {
      const vc = Number(rawVc);
      if (Number.isFinite(vc)) {
        tiktok.viewerCount = vc;
        emitTikTokStatus();
      }
    }
  });

  conn.on(WebcastEvent.STREAM_END, () => {
    if (tiktok.conn !== conn) return;
    tiktok.connected = false;
    tiktok.connecting = false;
    tiktok.error = 'Canlı yayım bitdi';
    emitTikTokStatus();
    scheduleReconnect(15000);
  });

  conn.on(ControlEvent.DISCONNECTED, () => {
    if (tiktok.conn !== conn) return;
    if (tiktok.connected) {
      tiktok.connected = false;
      tiktok.connecting = false;
      emitTikTokStatus();
      scheduleReconnect(5000);
    }
  });

  conn.on(ControlEvent.ERROR, (err) => {
    if (tiktok.conn !== conn) return;
    console.error('[TikTok ERROR]', err?.exception?.message || err?.info || err);
  });

  try {
    const state = await conn.connect();
    if (tiktok.conn !== conn) return;
    tiktok.connecting = false;
    tiktok.connected = true;
    tiktok.viewerCount = Number(state?.roomInfo?.data?.user_count ?? state?.roomInfo?.user_count ?? 0) || 0;
    tiktok.error = '';
    console.log(`[TikTok] Qoşuldu! Room ID: ${state.roomId}`);
    emitTikTokStatus();
  } catch (err) {
    if (tiktok.conn !== conn) return;
    const rawMsg = err?.message || String(err || '');
    const isOffline = /offline|not live|UserOffline|isn't online/i.test(rawMsg);
    tiktok.connecting = false;
    tiktok.connected = false;
    tiktok.error = isOffline
      ? `@${clean} hazırda canlı yayımda deyil (canlı başlayanda qoşulacaq)`
      : `Qoşulma xətası: ${rawMsg.slice(0, 90)}`;
    console.warn(`[TikTok] Qoşulmadı (${isOffline ? 'offline' : rawMsg})`);
    emitTikTokStatus();
    if (!isManual || isOffline) {
      scheduleReconnect(15000);
    }
  }
}

// ==================== SOCKET CONTROLS ====================
io.on('connection', (socket) => {
  socket.emit('arena-state', buildSnapshot(true));
  socket.emit('tiktok-status', {
    connecting: tiktok.connecting,
    connected: tiktok.connected,
    username: tiktok.username,
    viewerCount: tiktok.viewerCount,
    error: tiktok.error
  });

  socket.on('new-round', () => {
    game.roundNumber += 1;
    startLobby();
  });
  socket.on('start-battle-now', () => startBattle());
  socket.on('toggle-bots', ({ enabled } = {}) => {
    game.botsEnabled = !!enabled;
    saveSettings({ botsEnabled: game.botsEnabled });
    broadcastSnapshot(true);
  });
  socket.on('add-bots', ({ count } = {}) => {
    const n = Math.min(20, Math.max(1, Number(count) || 5));
    fillBots(Math.min(MAX_FIGHTERS, game.fighters.size + n));
    broadcastSnapshot(true);
  });
  socket.on('toggle-sound', ({ muted } = {}) => {
    game.soundMuted = !!muted;
    broadcastSnapshot(true);
  });
  socket.on('set-theme', ({ theme } = {}) => {
    if (!THEMES.includes(theme)) return;
    game.theme = theme;
    saveSettings({ theme });
    broadcastSnapshot(true);
  });
  socket.on('connect-tiktok', ({ username } = {}) => connectTikTok(username, true));
  socket.on('disconnect-tiktok', () => disconnectTikTok(true));
  socket.on('manual-cmd', ({ nickname, cmd } = {}) => {
    handleViewerChat({
      uniqueId: 'manual_host',
      nickname: nickname || 'Aparıcı',
      comment: String(cmd || '1')
    });
  });
});

// ==================== BOOT ====================
startLobby();
setInterval(stepPhysics, TICK_MS);

server.listen(PORT, () => {
  console.log(`\n================================================`);
  console.log(`  Canli Arena Battle Royale Server isleyir!`);
  console.log(`  Aparici Studiyasi : http://localhost:${PORT}`);
  console.log(`  OBS / Studio Link : http://localhost:${PORT}/?overlay=1`);
  console.log(`  TikTok Kanal      : @${tiktok.username}`);
  console.log(`================================================\n`);
  connectTikTok(DEFAULT_TIKTOK_USER, false);
});

process.on('uncaughtException', (err) => {
  console.error('[UncaughtException]', err?.stack || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});
