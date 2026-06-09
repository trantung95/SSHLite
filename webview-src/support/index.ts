// webview-src/support/index.ts
//
// Bootstraps the "Support SSH Lite" webview view: a script-driven pixel-art
// coder animation (canvas) plus link buttons that ask the extension to run the
// matching sshLite.* command.
//
// @author hybr8
//
// Contract with the extension (SupportViewProvider.handleMessage):
//   { type: 'action', cmd }                  -> sshLite.<cmd>
//   { type: 'setSetting', key, value }       -> workspace setting update (allow-listed)
//   { type: 'installHooks' | 'uninstallHooks'} -> add/remove AI prompt hooks
//   { type: 'ready' }                        -> ask the extension to echo settings + hook status
//   { type: 'log', level, scope, ... }        -> infoLog/diagLog (via log.ts)
//   { type: 'webviewError', message }         -> infoLog('support-view','webview-error')
// Extension -> webview:
//   { type: 'typed', src, text? }            -> the coder taps a hand; `text` (editor
//                                               insertions) flies the actual key(s) typed
//   { type: 'aiActive', id, name, prompt? }  -> float an AI assistant's name label; if `prompt`
//                                               is present (hooks installed) fly the typed text
//   { type: 'settings', npcAiActivity, npcCrossWindowBeacon } -> reflect the panel toggles
//   { type: 'hookStatus', tools, message? }  -> render the AI-hook install state
//
// Clicking the coder recolours a part (shirt / coffee mug / glasses), handled
// locally here (no link, no message). A zoom control sets an independent pixel
// width for the animation, capped at the section width.

import { info, diag, getVsCodeApi } from './log';

const vscode = getVsCodeApi();

// Persisted webview state (zoom + settings-panel open). VS Code keeps this across
// webview reloads, so the zoom level and panel state are remembered.
type PersistState = { zoom?: number; settingsOpen?: boolean };
const stateApi = vscode as unknown as { getState?: () => unknown; setState?: (s: unknown) => void };
function getState(): PersistState {
  try {
    return (stateApi.getState && (stateApi.getState() as PersistState)) || {};
  } catch (e) {
    return {};
  }
}
function patchState(patch: PersistState): void {
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
const POPUP_WORDS = ['const', 'let', 'async', 'await', 'ssh', 'sftp', 'git', 'npm', 'grep', 'vim', 'sudo', 'build', 'push', 'pull', 'diff', 'code', 'LITE', 'run'];
let promoCanvasEl: HTMLCanvasElement | null = null;

// Every activity pulse spawns a popup; the extension already throttles its
// pulses per source (30ms user / 150ms server + AI), so no extra rate limit here.
function spawnPopup(text: string): void {
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

// Labels for non-character keys (ev.key is a multi-char name for these) so EVERY
// key on the keyboard shows a readable keycap, not a random word. Covers the
// standard KeyboardEvent.key set; anything not listed falls back to its name.
const KEY_LABELS: Record<string, string> = {
  // whitespace / common edit
  ' ': 'Space', Tab: 'Tab', Enter: 'Enter', Escape: 'Esc', Backspace: 'Bksp',
  Delete: 'Del', Insert: 'Ins', Clear: 'Clr',
  // modifiers / locks
  Control: 'Ctrl', Alt: 'Alt', AltGraph: 'AltGr', Shift: 'Shift', Meta: 'Cmd',
  CapsLock: 'Caps', NumLock: 'Num', ScrollLock: 'Scroll', Fn: 'Fn', FnLock: 'FnLk',
  Super: 'Super', Hyper: 'Hyper',
  // navigation
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  // system / UI
  ContextMenu: 'Menu', Pause: 'Pause', PrintScreen: 'PrtSc', Help: 'Help',
  Cancel: 'Cancel', Select: 'Sel', Execute: 'Exec',
  // editing intents (some keyboards emit these)
  Copy: 'Copy', Cut: 'Cut', Paste: 'Paste', Undo: 'Undo', Redo: 'Redo', Again: 'Again',
  // numpad named keys
  Decimal: '.', Add: '+', Subtract: '-', Multiply: '*', Divide: '/', Separator: ',',
  // misc
  Dead: '◌', Unidentified: '?', Process: 'IME', Compose: 'Comp',
};
function keyLabel(key: string): string {
  if (KEY_LABELS[key]) {
    return KEY_LABELS[key];
  }
  if (key.length === 1) {
    return key.toUpperCase(); // letter / digit / punctuation / shifted symbol
  }
  if (/^F\d{1,2}$/.test(key)) {
    return key; // F1..F20
  }
  // Any other named key (media keys, launch apps, IME names, …): show its name,
  // capped so a very long value still fits the keycap.
  return key.length > 8 ? key.slice(0, 8) : key;
}

// When the actual key is known (the webview's own keydown), fly THAT key —
// including non-character keys like Tab / Ctrl / Alt (mapped via keyLabel). When
// it isn't (the extension's `typed` pulses can't see which key), fly a random
// word — never a random single key.
function registerKey(key?: string): void {
  lastTypeAt = performance.now();
  const text = key ? keyLabel(key) : POPUP_WORDS[Math.floor(Math.random() * POPUP_WORDS.length)];
  spawnPopup(text);
}

// When an AI event fires without a prompt (transcript-watcher pulse, no hooks),
// spawn 2–4 random-word popups at independent random delays within 0–3 s so the
// NPC looks genuinely busy rather than blipping once and going quiet.
function burstAiPopups(): void {
  const count = 7 + Math.floor(Math.random() * 11); // 7–17 popups
  for (let i = 0; i < count; i++) {
    const delay = 700 + Math.floor(Math.random() * 1300);
    window.setTimeout(() => {
      lastTypeAt = performance.now();
      spawnPopup(POPUP_WORDS[Math.floor(Math.random() * POPUP_WORDS.length)]);
    }, delay);
  }
}

// Fly the user's ACTUAL prompt text (pushed by an installed AI hook): a short
// staggered burst of the real characters, capped so a long prompt isn't a flood.
function flyPromptText(text: string): void {
  lastTypeAt = performance.now();
  const chars = text.replace(/\s+/g, '').slice(0, 10).split('');
  if (chars.length === 0) {
    registerKey();
    return;
  }
  chars.forEach((c, i) => {
    window.setTimeout(() => spawnPopup(c.toUpperCase()), i * 70);
  });
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

// ----------------------------------------------------------------------------
// Cheering banner ("băng cổ động"): once in a while a small tilted banner with a
// Vietnam flag (red field + centred yellow star) and a short text appears ABOVE
// the NPC's head, zooms in, lingers a few minutes, then zooms out. Each spawn
// randomises the tilt, the colours (background never the flag's red/yellow and
// always distinct from the text; text high-contrast against the background), the
// flag's left/right position (text before OR after it), and it follows the head's
// up/down bob. Rendered as DOM (crisp SVG + text) over the .promo container, like
// the keycaps and labels — never on the pixelated canvas.
// ----------------------------------------------------------------------------
const VN_BANNER_GAP_MIN = 10 * 60 * 1000; // ≥10 min between appearances
const VN_BANNER_GAP_RAND = 10 * 60 * 1000; // +0..10 min → 10–20 min apart
const VN_BANNER_HOLD_MIN = 3 * 60 * 1000; // ≥3 min visible
const VN_BANNER_HOLD_RAND = 2 * 60 * 1000; // +0..2 min → 3–5 min visible
const VN_BANNER_IN_MS = 450; // zoom-in (matches the CSS keyframe)
const VN_BANNER_OUT_MS = 450; // zoom-out
const VN_BANNER_MAX_TILT = 4; // ± degrees of random tilt
const VN_BANNER_RADIUS = 2; // band corner radius in internal px — MUST match styles.css .vnbanner
const VN_BANNER_MIN_OVERHANG = 1; // band's minimum width beyond the head (internal px, split both ends) — keep small so it hugs the head
const VN_BANNER_EXTRA_MAX = 4; // extra random width on top of the minimum (internal px)
// Internal-y (of the 160×120 art) where the headband sits: high on the forehead /
// at the hairline (hairline ~y27, glasses/brows ~y34) — like a sports fan's
// cheering headband, not floating above the head.
const VN_BANNER_FOREHEAD_Y = 28;
// Upward 5-point star centred in a 30×20 viewBox (cx=15, cy=10, R=6, r≈2.29).
const VN_STAR_POINTS =
  '15,4 16.35,8.27 20.71,8.29 17.19,10.91 18.53,15.18 15,12.55 11.47,15.18 12.81,10.91 9.29,8.29 13.65,8.27';

let bannerText = 'VN';
let bannerMode: 'occasional' | 'always' | 'never' = 'never'; // sshLite.npcBannerMode (default off)
let bannerEl: HTMLDivElement | null = null;
let bannerInnerEl: HTMLElement | null = null; // the content (flag+text) inside the band
let bannerBandW = 0; // the band's fixed width (px) — independent of the text
let bannerFlagSide: 'left' | 'right' = 'left'; // the flag always sits off to this side
let bannerBaseTop = 0; // the resting `top` (px); the head bob is added on top of it
let bannerPersistent = false; // whether the current banner is the always-on one (no auto-retire)
let bannerHoldTimer = 0; // timeout id for an occasional banner's auto-removal

// Random banner background hue that AVOIDS the flag's red (~345..360 / 0..15) and
// yellow (~40..70) bands. Picked from the two allowed arcs (15..40)∪(70..345) with
// no retry loop (map a value in a 300-wide range onto the arcs).
function pickBannerBgHue(): number {
  const r = Math.random() * 300; // 25 (15..40) + 275 (70..345)
  return r < 25 ? 15 + r : 70 + (r - 25);
}

// How see-through the band's BACKGROUND is. Applied only to --bg (an hsla fill),
// so the flag SVG and the text — separate child elements painted on top — stay
// fully opaque. A drop, not a wash: the band still reads as a solid headband.
const VN_BANNER_BG_ALPHA = 0.8;

// Background + text colours: background avoids red/yellow; text is a near-complement
// with the OPPOSITE lightness band, so it always contrasts and is never the same as
// the background. The background is kept paler (lower saturation) and slightly
// translucent (alpha) — the text keeps its lightness-based contrast pairing.
function pickBannerColours(): { bg: string; txt: string } {
  const bgHue = pickBannerBgHue();
  const dark = Math.random() < 0.5;
  const bgL = dark ? 22 + Math.random() * 14 : 64 + Math.random() * 14; // 22–36 or 64–78
  const bgS = 30 + Math.random() * 16; // 30–46 — paler ("nhạt hơn") than before
  const bg = `hsla(${Math.round(bgHue)}, ${Math.round(bgS)}%, ${Math.round(bgL)}%, ${VN_BANNER_BG_ALPHA})`;
  const txtHue = (bgHue + 150 + Math.random() * 60) % 360; // near-complement → "đối màu"
  const txtL = dark ? 80 + Math.random() * 12 : 16 + Math.random() * 12; // light on dark / dark on light
  const txtS = 70 + Math.random() * 20; // vivid → stands out
  const txt = hslToHex(txtHue, txtS, txtL);
  return { bg, txt };
}

// Build the banner CONTENT (flag + optional gap + text). Returned separately from
// the band so the text can be swapped in place without touching the band's width.
function makeBannerInner(headW: number, txt: string, side: 'left' | 'right'): HTMLDivElement {
  const inner = document.createElement('div');
  inner.className = 'vnbanner-inner';

  // Vietnam flag as an inline SVG (no asset; works under default-src 'none'),
  // sized to ~the NPC's glasses height so the band reads as a thin forehead
  // headband (the glasses lens is 6 of the head's 34 internal px).
  const glassesH = headW * (6 / 34);
  const flagH = Math.max(5, Math.round(glassesH * 0.85));
  const flagW = Math.round(flagH * 1.5); // 3:2 field
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'vnbanner-flag');
  svg.setAttribute('viewBox', '0 0 30 20');
  svg.setAttribute('width', String(flagW));
  svg.setAttribute('height', String(flagH));
  const rect = document.createElementNS(svgNS, 'rect');
  rect.setAttribute('width', '30');
  rect.setAttribute('height', '20');
  rect.setAttribute('fill', '#da251d');
  const star = document.createElementNS(svgNS, 'polygon');
  star.setAttribute('points', VN_STAR_POINTS);
  star.setAttribute('fill', '#ffff00');
  svg.appendChild(rect);
  svg.appendChild(star);

  if (txt) {
    const gap = document.createElement('span');
    gap.className = 'vnbanner-gap';
    const span = document.createElement('span');
    span.className = 'vnbanner-text';
    span.textContent = txt; // textContent → no HTML injection from a user-set value
    // The flag is the OUTERMOST element on `side`; the text trails toward the
    // centre, a short gap away. layoutBannerContent then pushes the group to that
    // side so the flag always sits off-centre (never mid-forehead).
    if (side === 'left') {
      inner.appendChild(svg);
      inner.appendChild(gap);
      inner.appendChild(span);
    } else {
      inner.appendChild(span);
      inner.appendChild(gap);
      inner.appendChild(svg);
    }
  } else {
    inner.appendChild(svg); // empty text → flag only
  }
  return inner;
}

// Centre the content inside the fixed-width band, shifting it left/right by a
// random clamped amount (so the flag's position varies) and shrinking it to fit
// only if it would exceed the band. Does NOT change the band's width.
function layoutBannerContent(inner: HTMLElement, bandW: number, scale: number, side: 'left' | 'right'): void {
  const blockW = inner.getBoundingClientRect().width || inner.offsetWidth;
  const pad = 4 * scale; // keep content off the rounded ends
  const avail = Math.max(0, bandW - 2 * pad);
  let fit = 1;
  let shift = 0;
  if (blockW <= 0) {
    // Layout not settled — leave it centred. Should not happen (appended to a
    // visible, laid-out container before measuring), so surface it if it does.
    diag('support-webview', 'vnbanner-blockw-zero', {});
  } else if (blockW > avail && avail > 0) {
    fit = avail / blockW; // shrink to fit the band (long text / tiny zoom)
  } else {
    const maxShift = Math.max(0, (avail - blockW) / 2);
    // Push the content strongly toward `side` (78–100% of the way) so the flag
    // always lands off-centre, never in the middle of the forehead.
    const frac = 0.78 + Math.random() * 0.22;
    shift = (side === 'left' ? -1 : 1) * maxShift * frac;
  }
  inner.style.setProperty('--fit', fit.toFixed(3));
  inner.style.setProperty('--shift', `${shift.toFixed(1)}px`);
}

// Swap the banner's content (flag + new text) in place, keeping the band's width,
// tilt, colours and position — so editing the text never resizes the banner.
function refreshBannerInner(): void {
  const canvas = promoCanvasEl;
  if (!bannerEl || !bannerInnerEl || !canvas) {
    return;
  }
  const scale = (canvas.offsetWidth || 160) / 160;
  const headW = canvas.offsetWidth * (34 / 160);
  const next = makeBannerInner(headW, bannerText, bannerFlagSide);
  bannerEl.replaceChild(next, bannerInnerEl);
  bannerInnerEl = next;
  layoutBannerContent(next, bannerBandW, scale, bannerFlagSide);
}

// Anchor centred on the head and just above its top; remember the resting `top`
// so the per-frame bob sync can add the head's vertical bob to it.
function placeVnBanner(outer: HTMLElement, canvas: HTMLCanvasElement): void {
  const cx = canvas.offsetLeft + canvas.offsetWidth * 0.5; // head centre x (internal 80/160)
  // Sit ON the forehead (like a fan's cheering headband), not in the empty space
  // above the head. `translate(-50%,-50%)` means `top` is the band's centre.
  bannerBaseTop = canvas.offsetTop + canvas.offsetHeight * (VN_BANNER_FOREHEAD_Y / 120);
  outer.style.left = `${cx}px`;
  outer.style.top = `${bannerBaseTop}px`;
}

function spawnVnBanner(persistent = false): void {
  const canvas = promoCanvasEl;
  const parent = canvas && canvas.parentElement;
  if (!canvas || !parent || bannerEl) {
    return; // one banner at a time
  }
  const scale = canvas.offsetWidth / 160;
  const headW = canvas.offsetWidth * (34 / 160); // head width in DOM px
  if (headW <= 0) {
    return;
  }
  // The band is a fixed-width headband. Its straight middle spans the head width;
  // it overhangs by a small fixed margin (VN_BANNER_MIN_OVERHANG, split both ends)
  // so it hugs the head, plus a few random px. Width does NOT depend on the text,
  // so editing the label never resizes it.
  const bandW = headW + (VN_BANNER_MIN_OVERHANG + Math.random() * VN_BANNER_EXTRA_MAX) * scale;
  const txt = bannerText;
  bannerFlagSide = Math.random() < 0.5 ? 'left' : 'right'; // flag off to a random side

  const outer = document.createElement('div');
  outer.className = 'vnbanner';
  outer.style.width = `${bandW.toFixed(1)}px`;
  const inner = makeBannerInner(headW, txt, bannerFlagSide);
  outer.appendChild(inner);

  const tilt = (Math.random() * 2 - 1) * VN_BANNER_MAX_TILT;
  const { bg, txt: txtColour } = pickBannerColours();
  outer.style.setProperty('--tilt', `${tilt.toFixed(2)}deg`);
  outer.style.setProperty('--in-ms', `${VN_BANNER_IN_MS}ms`);
  outer.style.setProperty('--out-ms', `${VN_BANNER_OUT_MS}ms`);
  outer.style.setProperty('--bg', bg);
  outer.style.setProperty('--txt', txtColour);

  parent.appendChild(outer);
  placeVnBanner(outer, canvas);
  layoutBannerContent(inner, bandW, scale, bannerFlagSide);

  bannerEl = outer;
  bannerInnerEl = inner;
  bannerBandW = bandW;
  bannerPersistent = persistent;
  diag('support-webview', 'vnbanner-spawn', { tilt: Math.round(tilt), hasText: !!txt, persistent });

  // An always-on banner stays; an occasional one retires after a few minutes.
  if (!persistent) {
    const hold = VN_BANNER_HOLD_MIN + Math.random() * VN_BANNER_HOLD_RAND;
    bannerHoldTimer = window.setTimeout(() => retireVnBanner(), hold);
  }
}

// Animate the current banner out and remove it. If always-on is still set once
// it's gone, immediately bring a fresh one back (e.g. after a text change).
function retireVnBanner(): void {
  const el = bannerEl;
  if (!el) {
    return;
  }
  if (bannerHoldTimer) {
    window.clearTimeout(bannerHoldTimer);
    bannerHoldTimer = 0;
  }
  el.classList.add('vnbanner-out');
  window.setTimeout(() => {
    if (el.parentElement) {
      el.parentElement.removeChild(el);
    }
    if (bannerEl === el) {
      bannerEl = null;
      bannerInnerEl = null;
      bannerBandW = 0;
      bannerPersistent = false;
      if (bannerMode === 'always') {
        spawnVnBanner(true); // keep it shown
      }
    }
  }, VN_BANNER_OUT_MS + 50);
}

// Reconcile the live banner with the visibility mode (occasional / always / never).
function applyBannerMode(): void {
  if (bannerMode === 'always') {
    if (!bannerEl) {
      spawnVnBanner(true);
    } else {
      // Promote an occasional banner to persistent: cancel its auto-removal.
      bannerPersistent = true;
      if (bannerHoldTimer) {
        window.clearTimeout(bannerHoldTimer);
        bannerHoldTimer = 0;
      }
    }
  } else if (bannerMode === 'never') {
    if (bannerEl) {
      retireVnBanner(); // hide any current banner; nothing respawns it
    }
  } else if (bannerEl && bannerPersistent) {
    // occasional: drop a leftover always-on banner; the occasional cycle resumes
    retireVnBanner();
  }
}

// Self-rescheduling occasional spawner (idle-glance pattern). Dies with the
// webview (retainContextWhenHidden:false), so no explicit teardown is needed.
function scheduleVnBanner(): void {
  const next = VN_BANNER_GAP_MIN + Math.random() * VN_BANNER_GAP_RAND;
  window.setTimeout(() => {
    // Only the 'occasional' mode spawns from the timer; 'always' already keeps a
    // persistent banner up, 'never' shows nothing.
    if (promoCanvasEl && !document.hidden && bannerMode === 'occasional') {
      spawnVnBanner();
    }
    scheduleVnBanner();
  }, next);
}

// Glue the banner to the head as it bobs up/down. `bob` is the internal-px head
// offset from draw(); convert to DOM px with the same scale --npc-scale uses.
function syncBannerToHeadBob(bob: number): void {
  const el = bannerEl;
  const canvas = promoCanvasEl;
  if (!el || !canvas) {
    return;
  }
  const scale = (canvas.offsetWidth || 160) / 160;
  el.style.top = `${bannerBaseTop + bob * scale}px`;
}

window.addEventListener('message', (ev: MessageEvent) => {
  const m = ev.data as { type?: string; src?: string; id?: string; name?: string; user?: string; prompt?: string; text?: string } | undefined;
  if (!m) {
    return;
  }
  if (m.type === 'typed') {
    // Editor edits carry the inserted text → fly the ACTUAL characters typed.
    // Sources without text (cursor move, deletion, terminal, window focus) → a
    // random word.
    if (typeof m.text === 'string' && m.text) {
      flyPromptText(m.text);
    } else {
      registerKey();
    }
    // Local-user activity (editing or typing in our own terminal) floats a
    // "you" label, mirroring the AI name labels.
    if ((m.src === 'editor' || m.src === 'terminal-in') && typeof m.user === 'string' && m.user) {
      showUserLabel(m.user);
    }
  } else if (m.type === 'aiActive' && typeof m.id === 'string' && typeof m.name === 'string') {
    showAiLabel(m.id, m.name);
    // Hooks installed: the AI tool pushed the actual prompt — fly the real text.
    // Otherwise a transcript-watcher pulse → burst of random words over 0–3 s.
    if (typeof m.prompt === 'string' && m.prompt) {
      flyPromptText(m.prompt);
    } else {
      burstAiPopups();
    }
    lastTypeAt = performance.now(); // an active AI keeps the NPC awake
  }
});
window.addEventListener('keydown', (ev: KeyboardEvent) => {
  const tgt = ev.target as HTMLElement | null;
  if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) {
    return; // typing inside a form field should not spawn popups
  }
  registerKey(ev.key);
});

// Grab keyboard focus when the user clicks a non-interactive area (the coder /
// canvas). Without this, clicking the panel leaves focus elsewhere and the
// keydown listener never fires — so modifier keys (Ctrl/Alt/Shift/CapsLock) and
// the rest only show once the panel actually holds keyboard focus.
window.addEventListener('pointerdown', (ev: PointerEvent) => {
  const tgt = ev.target as HTMLElement | null;
  if (tgt && tgt.closest('button, input, a, textarea, select')) {
    return; // let interactive controls keep their own focus
  }
  const container = document.querySelector('.support-container') as HTMLElement | null;
  if (container) {
    try {
      container.focus({ preventScroll: true });
    } catch (e) {
      container.focus();
    }
  }
});

// A mouse click anywhere in the panel pops a "Click" keycap (clicking a popup
// itself just dismisses it — its handler stops propagation, so it won't reach here).
window.addEventListener('click', () => {
  lastTypeAt = performance.now();
  spawnPopup('Click');
});

// Scrolling pops a "Scroll" keycap. Wheel events fire many times per scroll, so
// throttle; Ctrl+wheel is the zoom gesture (handled on the canvas), so skip it.
let lastScrollPopupAt = -10000;
window.addEventListener(
  'wheel',
  (ev: WheelEvent) => {
    if (ev.ctrlKey) {
      return;
    }
    const t = performance.now();
    if (t - lastScrollPopupAt < 250) {
      return;
    }
    lastScrollPopupAt = t;
    lastTypeAt = performance.now();
    spawnPopup('Scroll');
  },
  { passive: true }
);

// Settings panel: the gear button expands/collapses a panel with the NPC's
// reaction toggles and the AI-hook install controls. The extension owns the
// truth; we render optimistically and reconcile from `settings` / `hookStatus`.
interface HookToolState {
  id: string;
  name: string;
  present: boolean;
  installed: boolean;
  configPath?: string;
}

function setupSettingsPanel(): void {
  const gear = document.getElementById('settingsToggle');
  const panel = document.getElementById('npcSettings');
  if (!gear || !panel) {
    return;
  }

  let expanded = getState().settingsOpen === true;
  const renderPanel = (): void => {
    panel.classList.toggle('collapsed', !expanded);
    gear.setAttribute('aria-expanded', String(expanded));
  };
  renderPanel();
  gear.addEventListener('click', () => {
    expanded = !expanded;
    patchState({ settingsOpen: expanded });
    renderPanel();
    if (expanded) {
      vscode.postMessage({ type: 'ready' }); // refresh settings + hook status on open
    }
  });

  const setChecked = (id: string, on: boolean): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) {
      el.checked = on;
    }
  };
  const wireCheck = (id: string, key: string): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) {
      return;
    }
    el.addEventListener('change', () => {
      vscode.postMessage({ type: 'setSetting', key, value: el.checked });
    });
  };
  wireCheck('setCrossWindow', 'npcCrossWindowBeacon');

  const setText = (id: string, value: string): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el && el.value !== value) {
      el.value = value;
    }
  };
  // Text setting: debounce keystrokes, flush on change/blur. The value is clamped
  // to 5 chars here and again server-side (the maxlength attribute is not trusted).
  const wireText = (id: string, key: string): void => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el) {
      return;
    }
    let t = 0;
    const post = (): void => {
      vscode.postMessage({ type: 'setSetting', key, value: el.value.trim().slice(0, 5) });
    };
    el.addEventListener('input', () => {
      window.clearTimeout(t);
      t = window.setTimeout(post, 400);
    });
    el.addEventListener('change', () => {
      window.clearTimeout(t);
      post();
    });
  };
  const setSelect = (id: string, value: string): void => {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (el && el.value !== value) {
      el.value = value;
    }
  };
  const wireSelect = (id: string, key: string): void => {
    const el = document.getElementById(id) as HTMLSelectElement | null;
    if (!el) {
      return;
    }
    el.addEventListener('change', () => {
      vscode.postMessage({ type: 'setSetting', key, value: el.value });
    });
  };
  wireText('setBannerText', 'npcBannerText');
  wireSelect('setBannerMode', 'npcBannerMode');

  const installBtn = document.getElementById('installHooks') as HTMLButtonElement | null;
  const uninstallBtn = document.getElementById('uninstallHooks') as HTMLButtonElement | null;
  const setBusy = (busy: boolean): void => {
    if (installBtn) {
      installBtn.disabled = busy;
    }
    if (uninstallBtn) {
      uninstallBtn.disabled = busy;
    }
  };
  installBtn?.addEventListener('click', () => {
    setBusy(true);
    info('support-webview', 'hooks-install-click', {});
    vscode.postMessage({ type: 'installHooks' });
  });
  uninstallBtn?.addEventListener('click', () => {
    setBusy(true);
    info('support-webview', 'hooks-uninstall-click', {});
    vscode.postMessage({ type: 'uninstallHooks' });
  });

  const renderHookStatus = (tools: HookToolState[], message?: string): void => {
    setBusy(false);
    const list = document.getElementById('hookList');
    if (list) {
      list.textContent = '';
      // Only show AI tools actually detected on this machine (present home dir);
      // we never offer to write configs for tools the user doesn't have.
      const available = tools.filter((t) => t.present);
      if (available.length === 0) {
        const row = document.createElement('div');
        row.className = 'npc-hook-item';
        row.textContent = 'No supported AI tools detected.';
        list.appendChild(row);
      } else {
        available.forEach((t) => {
          const row = document.createElement('div');
          row.className = 'npc-hook-item';
          const dot = document.createElement('span');
          dot.className = 'npc-hook-dot';
          dot.textContent = t.installed ? '✓' : '•';
          dot.style.color = t.installed
            ? 'var(--vscode-testing-iconPassed, #3fb950)'
            : 'var(--vscode-descriptionForeground)';
          const label = document.createElement('span');
          label.textContent = t.name + (t.installed ? ' — on' : '');
          row.appendChild(dot);
          row.appendChild(label);
          list.appendChild(row);
          // When installed, show the hook config file path in dim text.
          if (t.installed && t.configPath) {
            const path = document.createElement('div');
            path.className = 'npc-hook-path';
            path.textContent = t.configPath;
            path.title = t.configPath;
            list.appendChild(path);
          }
        });
      }
    }
    const msg = document.getElementById('hookMsg');
    if (msg) {
      msg.textContent = message || '';
    }
  };

  window.addEventListener('message', (ev: MessageEvent) => {
    const m = ev.data as
      | {
          type?: string;
          npcAiActivity?: boolean;
          npcCrossWindowBeacon?: boolean;
          npcBannerText?: string;
          npcBannerMode?: string;
          tools?: HookToolState[];
          message?: string;
        }
      | undefined;
    if (!m) {
      return;
    }
    if (m.type === 'settings') {
      setChecked('setCrossWindow', !!m.npcCrossWindowBeacon);
      if (typeof m.npcBannerText === 'string') {
        const next = m.npcBannerText.trim().slice(0, 5);
        const changed = next !== bannerText;
        bannerText = next; // drive the banner live
        setText('setBannerText', bannerText);
        // Reflect a live text change on the current banner WITHOUT changing its
        // width: swap the content inside the fixed-width band in place.
        if (changed && bannerEl) {
          refreshBannerInner();
        }
      }
      if (typeof m.npcBannerMode === 'string') {
        bannerMode = m.npcBannerMode === 'always' || m.npcBannerMode === 'never' ? m.npcBannerMode : 'occasional';
        setSelect('setBannerMode', bannerMode);
        applyBannerMode();
      }
    } else if (m.type === 'hookStatus' && Array.isArray(m.tools)) {
      renderHookStatus(m.tools, m.message);
    }
  });

  // Ask the extension for current settings + hook status so the panel starts synced.
  vscode.postMessage({ type: 'ready' });
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
  // Publish the canvas display scale (display px / internal 160px) as a CSS var on
  // the .promo container so the floating popups/labels (which live there) scale
  // with the coder — otherwise they stay full-size when the NPC is zoomed out.
  const updateScale = (): void => {
    const parent = canvas.parentElement;
    if (!parent) {
      return;
    }
    const w = canvas.offsetWidth || canvas.getBoundingClientRect().width;
    const s = w > 0 ? w / (canvas.width || 160) : 1;
    parent.style.setProperty('--npc-scale', String(s));
  };
  const apply = (): void => {
    canvas.style.width = zoom > 0 ? `${zoom}px` : '100%';
    patchState({ zoom });
    updateScale();
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
  // Re-scale popups when the panel width changes (fit mode follows the section).
  window.addEventListener('resize', updateScale);
  requestAnimationFrame(updateScale); // once after first layout
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
  // Idle glance: when the mouse isn't driving the pupils, occasionally dart the
  // eyes in a RANDOM direction for ~1.5s, then back to centre ("liếc mắt").
  let glanceUntil = -10000;
  let nextGlanceAt = 4000;
  let glanceDX = 0;
  let glanceDY = 0;
  // Eye-white slack is wider than tall, so X spans ±2, Y spans ±1. Exclude (0,0).
  const GLANCE_DIRS = [
    [-2, 0], [2, 0], [0, -1], [0, 1],
    [-2, -1], [2, -1], [-2, 1], [2, 1],
    [-1, -1], [1, 1], [-1, 1], [1, -1],
  ];
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
    syncBannerToHeadBob(bob); // keep the cheering banner glued to the bobbing head

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
    // Pupils track the cursor (clamped) while the mouse is over the panel; when it
    // isn't, an occasional idle side-glance moves them instead.
    const mouseActive = now - lastMoveAt < 900;
    if (animate && !mouseActive && now >= nextGlanceAt) {
      const d = GLANCE_DIRS[Math.floor(Math.random() * GLANCE_DIRS.length)];
      glanceDX = d[0];
      glanceDY = d[1];
      glanceUntil = now + 1400 + Math.random() * 1100;
      nextGlanceAt = glanceUntil + 5000 + Math.random() * 7000;
    }
    const glancing = animate && !mouseActive && now < glanceUntil;
    const pdx = Math.round(mouseActive ? pupilDX : glancing ? glanceDX : 0);
    const pdy = Math.round(mouseActive ? pupilDY : glancing ? glanceDY : 0);
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
setupSettingsPanel();
scheduleVnBanner();
