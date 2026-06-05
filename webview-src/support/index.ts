// webview-src/support/index.ts
//
// Bootstraps the "Support SSH Lite" webview view: a script-driven pixel-art
// coder animation (canvas) plus link buttons that ask the extension to run the
// matching sshLite.* command.
//
// @author hybr8
//
// Contract with the extension (SupportViewProvider.handleMessage):
//   { type: 'action', cmd }            -> sshLite.<cmd>
//   { type: 'log', level, scope, ... }  -> infoLog/diagLog (via log.ts)
//   { type: 'webviewError', message }   -> infoLog('support-view','webview-error')
// Extension -> webview:
//   { type: 'typed', src }              -> the coder taps a hand (activity)
//   { type: 'aiActive', id, name }      -> float an AI assistant's name label
//
// Clicking the coder recolours a part (shirt / coffee mug / glasses), handled
// locally here (no link, no message). A zoom control sets an independent pixel
// width for the animation, capped at the section width.

import { info, getVsCodeApi } from './log';

const vscode = getVsCodeApi();

// Persisted webview state (zoom + popup rate). VS Code keeps this across webview
// reloads, so the settings are remembered.
const stateApi = vscode as unknown as { getState?: () => unknown; setState?: (s: unknown) => void };
function getState(): { zoom?: number; rate?: number } {
  try {
    return (stateApi.getState && (stateApi.getState() as { zoom?: number; rate?: number })) || {};
  } catch (e) {
    return {};
  }
}
function patchState(patch: { zoom?: number; rate?: number }): void {
  try {
    if (stateApi.setState) {
      stateApi.setState({ ...getState(), ...patch });
    }
  } catch (e) {
    /* state not available */
  }
}

// ----------------------------------------------------------------------------
// Link buttons: post an action back to the extension. (The promo canvas has no
// data-cmd, so it never posts; clicking it recolours the coder instead.)
// ----------------------------------------------------------------------------
document.querySelectorAll<HTMLElement>('[data-cmd]').forEach((el) => {
  el.addEventListener('click', () => {
    const cmd = el.getAttribute('data-cmd');
    if (!cmd) {
      return;
    }
    info('support-webview', 'action-click', { cmd });
    vscode.postMessage({ type: 'action', cmd });
  });
});

window.addEventListener('error', (e: ErrorEvent) => {
  vscode.postMessage({
    type: 'webviewError',
    message: String(e.message),
    stack: e.error && e.error.stack ? String(e.error.stack) : undefined,
  });
});

// Static (non-recolourable) palette.
const C = {
  skin: '#ecbb91',
  skinHi: '#f4d2af',
  skinShade: '#e3ad84',
  skinLine: '#cf9b78',
  hair: '#5a3b22',
  hairLine: '#43301c',
  string: '#dfe9e9',
  desk: '#6f4a30',
  deskLite: '#8a5e3c',
  deskDark: '#543822',
  key: '#353648',
  keyCap: '#54566a',
  white: '#f6f6f6',
  pupil: '#1f2030',
  mouth: '#b5654a',
  nose: '#d99873',
  blush: '#e8957f',
  steam: '#cfe9ec',
  glow: '#5ef0e0',
  word: '#7fb3e0',
};

// --- colour helpers (recolourable parts derive shades from one hue) ---
function hslToHex(h: number, s: number, l: number): string {
  const sn = s / 100;
  const ln = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number): number => {
    const c = ln - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return Math.round(255 * c);
  };
  const hx = (v: number): string => v.toString(16).padStart(2, '0');
  return `#${hx(f(0))}${hx(f(8))}${hx(f(4))}`;
}
const rndHue = (): number => Math.floor(Math.random() * 360);
const makeHoodie = (h: number) => ({
  main: hslToHex(h, 48, 42),
  lite: hslToHex(h, 48, 56),
  dark: hslToHex(h, 48, 32),
  dark2: hslToHex(h, 50, 24),
});
const makeMug = (h: number) => ({ main: hslToHex(h, 60, 48), lite: hslToHex(h, 60, 62) });
const makeGlasses = (h: number) => ({ frame: hslToHex(h, 55, 66), glint: hslToHex(h, 55, 84) });

// ----------------------------------------------------------------------------
// Typing state: driven by real activity (the extension forwards {type:'typed'}
// on editor edits / cursor moves / terminal commands; we also react to keys
// typed while the webview has focus). While typing is recent both hands bob.
// ----------------------------------------------------------------------------
let lastTypeAt = -10000;

// Floating popups: occasionally a just-typed key, a random key, or a random word
// pops up as a little keycap around the keyboard, in a random colour, then fades
// and floats up; clicking it dismisses it. Rendered as real DOM elements (crisp
// text) rather than on the pixelated canvas.
const POPUP_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789{}();=>'.split('');
const POPUP_WORDS = ['const', 'let', 'async', 'await', 'ssh', 'sftp', 'git', 'npm', 'grep', 'vim', 'sudo', 'build', 'push', 'pull', 'diff', 'code', 'LITE', 'run'];
let lastPopupAt = -10000;
let promoCanvasEl: HTMLCanvasElement | null = null;
// Max popups per minute (0 = every key spawns one). Editable + persisted.
let popupRate = ((): number => {
  const r = getState().rate;
  return typeof r === 'number' && r >= 0 ? Math.floor(r) : 0;
})();

function spawnPopup(text: string): void {
  const t = performance.now();
  const minInterval = popupRate > 0 ? 60000 / popupRate : 0;
  if (t - lastPopupAt < minInterval) {
    return; // throttle to popupRate per minute (0 = no throttle)
  }
  lastPopupAt = t;
  const canvas = promoCanvasEl;
  const parent = canvas && canvas.parentElement;
  if (!canvas || !parent) {
    return;
  }
  const el = document.createElement('div');
  el.className = 'kpop';
  el.textContent = text;
  el.style.background = hslToHex(Math.floor(Math.random() * 360), 80, 62);
  const fracX = 0.28 + Math.random() * 0.5; // around the keyboard, horizontally
  const fracY = 0.6 + Math.random() * 0.22; // lower third, near the keys
  el.style.left = `${canvas.offsetLeft + fracX * canvas.offsetWidth}px`;
  el.style.top = `${canvas.offsetTop + fracY * canvas.offsetHeight}px`;
  const remove = (): void => {
    if (el.parentElement) {
      el.parentElement.removeChild(el);
    }
  };
  el.addEventListener('click', (ev: MouseEvent) => {
    ev.stopPropagation();
    remove(); // click to dismiss
  });
  el.addEventListener('animationend', remove);
  parent.appendChild(el);
  window.setTimeout(remove, 1000); // safety net if animationend does not fire
}

function registerKey(key?: string): void {
  lastTypeAt = performance.now();
  let text: string;
  if (Math.random() < 0.4) {
    text = POPUP_WORDS[Math.floor(Math.random() * POPUP_WORDS.length)]; // sometimes a word
  } else {
    const useReal = !!key && key.length === 1 && key !== ' ';
    text = useReal ? (key as string).toUpperCase() : POPUP_KEYS[Math.floor(Math.random() * POPUP_KEYS.length)];
  }
  spawnPopup(text);
}

// ----------------------------------------------------------------------------
// AI-assistant name labels: when the extension reports an AI coding assistant is
// active (it watches the tools' transcript files), float the tool's NAME around
// the NPC. Multiple tools => multiple labels at scattered positions. A label is
// removed once no further activity arrives for AI_LABEL_TTL (the watcher can't
// tell us when a tool stops, so we infer "stopped" from silence).
// ----------------------------------------------------------------------------
const AI_LABEL_TTL = 2000;
interface AiLabel {
  el: HTMLDivElement;
  lastSeen: number;
}
const aiLabels = new Map<string, AiLabel>();
let aiLabelSeq = 0;

function placeAiLabel(el: HTMLDivElement, canvas: HTMLCanvasElement, index: number): void {
  // Scatter around an arc over the head / upper body, with a little jitter.
  const angles = [-90, -45, -135, 0, 180, -25, -160, 45, -70];
  const deg = angles[index % angles.length] + (Math.random() * 24 - 12);
  const ang = (deg * Math.PI) / 180;
  const cx = canvas.offsetLeft + canvas.offsetWidth * 0.5;
  const cy = canvas.offsetTop + canvas.offsetHeight * 0.3;
  const r = canvas.offsetWidth * (0.3 + Math.random() * 0.12);
  el.style.left = `${cx + Math.cos(ang) * r}px`;
  el.style.top = `${cy + Math.sin(ang) * r * 0.8}px`;
}

// Create a floating label (or refresh its TTL if it already exists). Returns
// true when a new element was created. Used for both AI tools and the local user.
function upsertLabel(key: string, text: string, bg: string, extraClass?: string): boolean {
  const canvas = promoCanvasEl;
  const parent = canvas && canvas.parentElement;
  if (!canvas || !parent) {
    return false;
  }
  const now = performance.now();
  const existing = aiLabels.get(key);
  if (existing) {
    existing.lastSeen = now;
    return false;
  }
  const el = document.createElement('div');
  el.className = extraClass ? `ailabel ${extraClass}` : 'ailabel';
  el.textContent = text;
  el.style.background = bg;
  placeAiLabel(el, canvas, aiLabelSeq++);
  parent.appendChild(el);
  aiLabels.set(key, { el, lastSeen: now });
  return true;
}

function showAiLabel(id: string, name: string): void {
  if (upsertLabel(`ai:${id}`, name, hslToHex(Math.floor(Math.random() * 360), 70, 50))) {
    info('support-webview', 'ai-label-add', { id });
  }
}

// The LOCAL user working: a single label keyed '__user__', refreshed on each
// editor / own-terminal pulse, expiring via the same TTL sweep as AI labels.
function showUserLabel(name: string): void {
  if (upsertLabel('__user__', name, '#ffd479', 'userlabel')) {
    info('support-webview', 'user-label-add', {});
  }
}

function sweepAiLabels(): void {
  if (aiLabels.size === 0) {
    return;
  }
  const now = performance.now();
  for (const [id, entry] of [...aiLabels]) {
    if (now - entry.lastSeen > AI_LABEL_TTL) {
      const el = entry.el;
      el.classList.add('ailabel-out');
      window.setTimeout(() => {
        if (el.parentElement) {
          el.parentElement.removeChild(el);
        }
      }, 400);
      aiLabels.delete(id);
      info('support-webview', 'ai-label-expire', { id });
    }
  }
}
// Always-on (cheap) sweep so labels expire even under prefers-reduced-motion.
window.setInterval(sweepAiLabels, 1000);

window.addEventListener('message', (ev: MessageEvent) => {
  const m = ev.data as { type?: string; src?: string; id?: string; name?: string; user?: string } | undefined;
  if (!m) {
    return;
  }
  if (m.type === 'typed') {
    registerKey(); // editor/terminal/window activity: key unknown, use a random key or word
    // Local-user activity (editing or typing in our own terminal) floats a
    // "you" label, mirroring the AI name labels.
    if ((m.src === 'editor' || m.src === 'terminal-in') && typeof m.user === 'string' && m.user) {
      showUserLabel(m.user);
    }
  } else if (m.type === 'aiActive' && typeof m.id === 'string' && typeof m.name === 'string') {
    showAiLabel(m.id, m.name);
    lastTypeAt = performance.now(); // an active AI keeps the NPC awake
  }
});
window.addEventListener('keydown', (ev: KeyboardEvent) => {
  const tgt = ev.target as HTMLElement | null;
  if (tgt && tgt.tagName === 'INPUT') {
    return; // typing in the rate field should not spawn popups
  }
  registerKey(ev.key);
});

// Rate input: edit how many key popups appear per minute (0 = every key).
// Auto-saves on change; rejects negative / invalid input.
function setupRate(): void {
  const input = document.getElementById('rateInput') as HTMLInputElement | null;
  if (!input) {
    return;
  }
  input.value = String(popupRate);
  const commit = (): void => {
    const raw = input.value;
    if (raw === '') {
      return; // mid-edit, wait for a value
    }
    const v = parseInt(raw, 10);
    if (isNaN(v) || v < 0) {
      input.value = String(popupRate); // reject negative / invalid
      return;
    }
    popupRate = v;
    patchState({ rate: popupRate });
  };
  input.addEventListener('input', commit);
  input.addEventListener('change', commit);
  input.addEventListener('blur', () => {
    if (input.value === '') {
      input.value = String(popupRate);
    }
  });
}

// ----------------------------------------------------------------------------
// Independent zoom: sets the canvas CSS width in px (zoom > 0) or "fit" (100%).
// max-width:100% in CSS caps it at the section width, so the art can never be
// wider than the section. The level persists across re-renders via webview state.
// ----------------------------------------------------------------------------
function setupZoom(canvas: HTMLCanvasElement): void {
  const ZMIN = 60;
  const ZMAX = 2000;
  const STEP = 24;
  const saved = getState().zoom;
  let zoom = typeof saved === 'number' && saved > 0 ? saved : 0; // 0 = fit to section width
  const apply = (): void => {
    canvas.style.width = zoom > 0 ? `${zoom}px` : '100%';
    patchState({ zoom });
  };
  const cur = (): number => Math.round(canvas.getBoundingClientRect().width) || canvas.width;
  const zoomIn = (): void => {
    const base = zoom > 0 ? zoom : cur();
    zoom = Math.min(ZMAX, base + STEP);
    apply();
  };
  const zoomOut = (): void => {
    const base = zoom > 0 ? zoom : cur();
    zoom = Math.max(ZMIN, base - STEP);
    apply();
  };
  const fit = (): void => {
    zoom = 0;
    apply();
  };
  const wire = (id: string, fn: () => void): void => {
    const b = document.getElementById(id);
    if (b) {
      b.addEventListener('click', fn);
    }
  };
  wire('zoomIn', zoomIn);
  wire('zoomOut', zoomOut);
  wire('zoomFit', fit);
  canvas.addEventListener(
    'wheel',
    (ev: WheelEvent) => {
      if (!ev.ctrlKey) {
        return;
      }
      ev.preventDefault();
      if (ev.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    },
    { passive: false }
  );
  apply();
}

function startPromo(): void {
  const canvas = document.getElementById('promoCanvas') as HTMLCanvasElement | null;
  if (!canvas) {
    return;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  ctx.imageSmoothingEnabled = false;
  setupZoom(canvas);
  promoCanvasEl = canvas;

  const W = canvas.width;
  const H = canvas.height;

  // Eyes-follow-cursor (panel only): pupils nudge toward the mouse while it is
  // over the canvas, clamped to the small slack inside the eye-whites.
  let pupilDX = 0;
  let pupilDY = 0;
  let lastMoveAt = -10000;
  canvas.addEventListener('mousemove', (ev: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const cx = ((ev.clientX - rect.left) / rect.width) * W;
    const cy = ((ev.clientY - rect.top) / rect.height) * H;
    const clamp = (v: number, m: number): number => Math.max(-m, Math.min(m, v));
    pupilDX = clamp((cx - 80) / 18, 2);
    pupilDY = clamp((cy - 37) / 28, 1);
    lastMoveAt = performance.now();
  });
  canvas.addEventListener('mouseleave', () => {
    pupilDX = 0;
    pupilDY = 0;
  });

  // Idle drowsiness: after a stretch with no activity the coder dozes off,
  // closing its eyes in a slow "breathing" rhythm until something wakes it.
  const SLEEP_AFTER = 15000;
  let sleepLogged = false;

  // Recolourable parts (start near the original teal / red / cyan).
  let hood = makeHoodie(180);
  let mug = makeMug(6);
  let glasses = makeGlasses(190);

  const px = (x: number, y: number, w: number, h: number, color: string): void => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  const box = (x: number, y: number, w: number, h: number, color: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  };

  // A rounded back-of-hand with three fingers + inner thumb. `dip` bobs the
  // whole hand down while typing (the up/down motion the user liked).
  const drawHand = (hx: number, hy0: number, dip: number, isLeft: boolean): void => {
    const hy = hy0 + dip;
    px(hx + 1, hy, 8, 1, C.skinHi); // rounded top
    px(hx, hy + 1, 10, 3, C.skin); // back of hand
    px(hx + 1, hy + 1, 8, 1, C.skinHi); // knuckle highlight
    px(hx, hy + 4, 10, 1, C.skinLine); // shade under knuckles
    px(isLeft ? hx + 9 : hx - 1, hy + 2, 2, 2, C.skin); // thumb (inner side)
    for (let i = 0; i < 3; i++) {
      const fx = hx + 1 + i * 3;
      px(fx, hy + 5, 2, 3, C.skin); // finger
      px(fx, hy + 7, 2, 1, C.skinLine); // fingertip shade
    }
  };

  const wallGrad = ctx.createLinearGradient(0, 0, 0, H);
  wallGrad.addColorStop(0, '#1a1d33');
  wallGrad.addColorStop(1, '#0f1222');

  let nextBlinkAt = 1500;
  let blinkUntil = 0;

  const draw = (now: number, animate: boolean): void => {
    ctx.fillStyle = wallGrad;
    ctx.fillRect(0, 0, W, H);
    px(0, 104, W, 16, '#14182a');

    const glowA = animate ? 0.09 + 0.05 * (0.5 + 0.5 * Math.sin(now / 1700)) : 0.12;
    const halo = ctx.createRadialGradient(80, 54, 6, 80, 54, 48);
    halo.addColorStop(0, C.glow);
    halo.addColorStop(1, 'rgba(94,240,224,0)');
    ctx.globalAlpha = glowA;
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(80, 54, 48, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    const bob = animate ? Math.round(Math.sin(now / 760)) : 0;

    // ----- body / hoodie (slim build) -----
    px(54, 50, 52, 38, hood.main);
    px(54, 50, 52, 4, hood.lite);
    px(54, 50, 4, 38, hood.dark);
    px(102, 50, 4, 38, hood.dark);
    px(67, 48, 26, 6, hood.dark2); // collar
    px(68, 70, 24, 12, hood.dark); // pocket
    px(68, 70, 24, 1, hood.dark2);
    px(68, 70, 1, 12, hood.dark2);
    px(91, 70, 1, 12, hood.dark2);
    px(77, 52, 1, 12, C.string); // drawstrings
    px(83, 52, 1, 12, C.string);
    px(76, 63, 2, 2, C.string);
    px(83, 63, 2, 2, C.string);
    px(74, 44, 12, 8, C.skinShade); // neck

    // ----- head -----
    const hy = bob;
    px(63, 19 + hy, 34, 9, C.hair);
    px(63, 28 + hy, 4, 14, C.hair);
    px(93, 28 + hy, 4, 14, C.hair);
    px(65, 27 + hy, 30, 21, C.skin);
    px(65, 27 + hy, 30, 4, C.hair);
    px(63, 34 + hy, 3, 7, C.skinShade);
    px(94, 34 + hy, 3, 7, C.skinShade);
    ctx.globalAlpha = 0.6;
    px(67, 41 + hy, 3, 2, C.blush);
    px(90, 41 + hy, 3, 2, C.blush);
    ctx.globalAlpha = 1;

    px(69, 33 + hy, 8, 1, C.hairLine);
    px(83, 33 + hy, 8, 1, C.hairLine);
    px(69, 35 + hy, 8, 4, C.white);
    px(83, 35 + hy, 8, 4, C.white);
    // Pupils track the cursor (clamped) while the mouse is over the panel.
    const pdx = Math.round(pupilDX);
    const pdy = Math.round(pupilDY);
    px(72 + pdx, 35 + hy + pdy, 3, 4, C.pupil);
    px(85 + pdx, 35 + hy + pdy, 3, 4, C.pupil);

    // Eyes shut on a normal blink, or while dozing (slow breathing rhythm).
    const idleMs = now - lastTypeAt;
    const sleeping = animate && idleMs > SLEEP_AFTER;
    const sleepShut = sleeping && (now / 3900) % 1 < 0.9;
    if (sleeping !== sleepLogged) {
      sleepLogged = sleeping;
      info('support-webview', sleeping ? 'sleep-enter' : 'sleep-wake', {});
    }
    if ((animate && now < blinkUntil) || sleepShut) {
      px(69, 35 + hy, 8, 4, C.skin);
      px(83, 35 + hy, 8, 4, C.skin);
    }

    box(68, 34 + hy, 10, 6, glasses.frame);
    box(82, 34 + hy, 10, 6, glasses.frame);
    px(78, 36 + hy, 4, 1, glasses.frame);
    px(66, 35 + hy, 2, 1, glasses.frame);
    px(92, 35 + hy, 2, 1, glasses.frame);
    const glintA = animate ? 0.1 + 0.45 * (0.5 + 0.5 * Math.sin(now / 1300)) : 0.4;
    ctx.globalAlpha = glintA;
    px(70, 35 + hy, 3, 2, glasses.glint);
    px(84, 35 + hy, 3, 2, glasses.glint);
    ctx.globalAlpha = 1;

    px(79, 40 + hy, 2, 3, C.nose);
    px(74, 43 + hy, 12, 2, C.mouth);

    // ----- desk + keyboard -----
    px(6, 88, 148, 8, C.desk);
    px(6, 88, 148, 2, C.deskLite);
    px(6, 96, 148, 4, C.deskDark);
    px(54, 89, 52, 5, C.key);
    for (let i = 0; i < 8; i++) {
      px(56 + i * 6, 90, i === 7 ? 2 : 4, 2, C.keyCap);
    }

    // ----- arms (hoodie sleeves) -----
    px(52, 54, 11, 9, hood.main); // left
    px(54, 62, 11, 9, hood.main);
    px(57, 70, 11, 10, hood.main);
    px(52, 54, 2, 9, hood.dark);
    px(54, 62, 2, 9, hood.dark);
    px(57, 70, 2, 9, hood.dark);
    px(57, 78, 12, 5, hood.lite); // cuff (tall enough to cover the bob)
    px(97, 54, 11, 9, hood.main); // right
    px(95, 62, 11, 9, hood.main);
    px(92, 70, 11, 10, hood.main);
    px(106, 54, 2, 9, hood.dark);
    px(104, 62, 2, 9, hood.dark);
    px(101, 70, 2, 9, hood.dark);
    px(91, 78, 12, 5, hood.lite); // cuff (tall enough to cover the bob)

    // ----- hands: bob up/down (alternating) while typing, otherwise rest -----
    const typingNow = animate && now - lastTypeAt < 260;
    const offL = typingNow && Math.sin(now / 80) < 0 ? 2 : 0;
    const offR = typingNow && Math.sin(now / 80 + Math.PI) < 0 ? 2 : 0;
    drawHand(58, 80, offL, true);
    drawHand(90, 80, offR, false);

    // ----- coffee mug + steam -----
    px(124, 78, 12, 10, mug.main);
    px(124, 78, 12, 2, mug.lite);
    box(136, 80, 3, 5, mug.main);
    if (animate) {
      const drawSteam = (sx: number, phase: number): void => {
        const p = (((now / 2000 + phase) % 1) + 1) % 1;
        ctx.globalAlpha = 0.7 * Math.sin(p * Math.PI);
        px(sx, Math.round(74 - p * 10), 2, 3, C.steam);
        ctx.globalAlpha = 1;
      };
      drawSteam(127, 0);
      drawSteam(131, 0.45);
    } else {
      ctx.globalAlpha = 0.5;
      px(127, 70, 2, 3, C.steam);
      ctx.globalAlpha = 1;
    }

    ctx.globalAlpha = 0.85;
    ctx.fillStyle = C.word;
    ctx.font = 'bold 8px monospace';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('SSH LITE', 8, 115);
    ctx.globalAlpha = 1;
  };

  // Click a part of the coder to recolour it (shirt / coffee mug / glasses).
  canvas.addEventListener('click', (ev: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }
    const x = ((ev.clientX - rect.left) / rect.width) * W;
    const y = ((ev.clientY - rect.top) / rect.height) * H;

    let part: string;
    if (x >= 64 && x <= 96 && y >= 31 && y <= 45) {
      glasses = makeGlasses(rndHue());
      part = 'glasses';
    } else if (x >= 121 && x <= 141 && y >= 75 && y <= 91) {
      mug = makeMug(rndHue());
      part = 'mug';
    } else if (x >= 50 && x <= 110 && y >= 48 && y <= 92) {
      hood = makeHoodie(rndHue());
      part = 'shirt';
    } else {
      return;
    }
    info('support-webview', 'recolor', { part });
    draw(performance.now(), true); // snappy feedback
  });

  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    info('support-webview', 'promo-static', { reason: 'reduced-motion' });
    draw(0, false);
    return;
  }

  info('support-webview', 'promo-animate', {});
  let last = 0;
  const tick = (t: number): void => {
    // Adaptive throttle: ~30fps while typing or moving the mouse (snappy),
    // ~11fps idle (LITE).
    const interval = t - lastTypeAt < 900 || t - lastMoveAt < 900 ? 33 : 90;
    if (t - last >= interval) {
      last = t;
      if (t >= nextBlinkAt) {
        blinkUntil = t + 130;
        nextBlinkAt = t + 2200 + Math.floor(Math.random() * 2800);
      }
      draw(t, true);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

info('support-webview', 'ready', {});
startPromo();
setupRate();
