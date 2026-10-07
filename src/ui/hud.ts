// The on-screen UI: icon tiles at the window's edge that unfold paper cards, the
// controls hint, the status note, and the loading and title screens. It owns its
// DOM and what is open; the app tells it what happened and is called back with
// what the player asked for. See context/ui.md.

import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource/patrick-hand-sc/400.css';
import './ui.css';
import { el, piece, tile } from './paper';
import { createDebugPanel, type DebugPanel } from './debug-panel';

export interface Room { id: string; label: string }

export interface HudOptions {
  rooms: Room[];
  onPickRoom(id: string): void;
  onImport(file: File): void;
  onReset(): void;
}

/** busy: stays until replaced. done: clears itself. error: stays until clicked or replaced. */
export type StatusKind = 'busy' | 'done' | 'error';

export interface Hud {
  debug: DebugPanel;
  /** Add a room to the list, or rename it if it is already there. */
  addRoom(room: Room): void;
  setCurrentRoom(id: string): void;
  status(message: string, kind: StatusKind): void;
  /** Show or hide the loading note (the waiting scene itself is 3D: loading-scene.ts). */
  setLoading(on: boolean): void;
  /** The value of a style token (e.g. `--paper`), for 3D things that must match the UI. */
  token(name: string): string;
  toggleDebug(): void;
  /** True while the title screen is up: the game should not take input yet. */
  titleOpen(): boolean;
  /** True if `target` is part of the UI: a key pressed there belongs to that control. */
  owns(target: EventTarget | null): boolean;
}

const TITLE = ['Wee', 'Wonderer'];
const TITLE_SEEN_KEY = 'ww.titleSeen'; // localStorage: set once the player has pressed Begin on this device
const DONE_STATUS_MS = 2400;           // long enough to read one line, short enough not to sit over the view

function titleSeen(): boolean {
  try { return localStorage.getItem(TITLE_SEEN_KEY) === '1'; } catch { return false; } // no storage: show it every time
}

export function createHud(opts: HudOptions): Hud {
  const root = el('div', 'ww-ui');

  // --- tiles ---
  const roomsTile = tile('rooms', 'Rooms', 0);
  const resetTile = tile('reset', 'Back to the start', 1);
  const debugTile = tile('debug', 'Debug', 2);
  const top = el('div', 'ww-corner ww-corner-top');
  top.appendChild(roomsTile);
  const bottom = el('div', 'ww-corner ww-corner-bottom');
  bottom.append(resetTile, debugTile);

  // --- cards: at most one is unfolded at a time ---
  const roomsCard = el('section', 'ww-card ww-rooms');
  roomsCard.appendChild(el('h2', 'ww-heading', 'Rooms'));
  const roomList = roomsCard.appendChild(el('ul'));
  const debug = createDebugPanel();
  const cards = [{ tile: roomsTile, card: roomsCard }, { tile: debugTile, card: debug.el }];
  function unfold(target: HTMLElement | null): void {
    for (const c of cards) {
      c.card.hidden = c.card !== target;
      c.tile.setAttribute('aria-expanded', String(c.card === target));
    }
  }
  for (const c of cards) c.tile.onclick = () => unfold(c.card.hidden ? c.card : null);
  unfold(null);
  resetTile.onclick = () => opts.onReset();

  // --- rooms list: the rooms, then the way to add your own ---
  const picker = el('input');
  picker.type = 'file';
  picker.accept = '.ply';
  picker.hidden = true;
  picker.onchange = () => { if (picker.files?.[0]) opts.onImport(picker.files[0]); picker.value = ''; };
  const importItem = el('li');
  const importButton = importItem.appendChild(el('button', 'ww-import', '+ Import your own scan'));
  importButton.title = 'An uncompressed 3DGS .ply. You can also drop the file on the window.';
  importButton.onclick = () => picker.click();
  roomList.appendChild(importItem);
  const roomButtons = new Map<string, HTMLButtonElement>();
  let currentRoom = '';
  function addRoom(room: Room): void {
    let button = roomButtons.get(room.id);
    if (!button) {
      button = el('button');
      button.onclick = () => { unfold(null); opts.onPickRoom(room.id); };
      const item = el('li');
      item.appendChild(button);
      roomList.insertBefore(item, importItem);
      roomButtons.set(room.id, button);
    }
    button.textContent = room.label;
    button.setAttribute('aria-current', String(room.id === currentRoom));
  }
  function setCurrentRoom(id: string): void {
    currentRoom = id;
    for (const [roomId, button] of roomButtons) button.setAttribute('aria-current', String(roomId === id));
  }
  opts.rooms.forEach(addRoom);

  // --- controls hint ---
  const hint = el('div', 'ww-hint');
  const hintLine = (keys: string[], does: string) => {
    const line = hint.appendChild(el('span'));
    for (const k of keys) line.appendChild(el('kbd', 'ww-key', k));
    line.append(does);
  };
  hintLine(['W', 'A', 'S', 'D'], 'walk');
  hintLine(['Shift'], 'run');
  hintLine(['Space'], 'jump');
  hintLine([], 'walk into a wall to climb');

  // --- status note ---
  const statusEl = el('div', 'ww-card ww-status');
  statusEl.setAttribute('role', 'status');
  statusEl.hidden = true;
  statusEl.onclick = () => { statusEl.hidden = true; };
  let statusTimer = 0;
  function status(message: string, kind: StatusKind): void {
    clearTimeout(statusTimer);
    statusEl.textContent = message;
    statusEl.dataset.kind = kind;
    statusEl.hidden = false;
    if (kind === 'done') statusTimer = window.setTimeout(() => { statusEl.hidden = true; }, DONE_STATUS_MS);
  }

  // --- drop a .ply anywhere to import it ---
  const drop = el('div', 'ww-screen ww-drop');
  drop.appendChild(el('div', 'ww-card', 'Drop a .ply to import'));
  drop.hidden = true;
  let dragDepth = 0; // dragenter/dragleave fire per element crossed, so count them
  addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; drop.hidden = false; });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) drop.hidden = true; });
  addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; drop.hidden = true;
    const f = e.dataTransfer?.files?.[0]; if (f) opts.onImport(f);
  });

  // --- loading note ---
  const loading = el('div', 'ww-screen ww-loading');
  loading.appendChild(el('p', 'ww-card', 'Building the room…'));
  function setLoading(on: boolean): void {
    loading.dataset.on = String(on);
    hint.hidden = on; // the keys it lists do nothing until there is a room
  }
  setLoading(true); // loading from the first frame; the app says when there is a room

  // --- title screen: one paper tile per letter ---
  const title = el('div', 'ww-screen ww-title');
  const heading = title.appendChild(el('h1'));
  heading.setAttribute('aria-label', TITLE.join(' '));
  TITLE.forEach((word, w) => {
    const line = heading.appendChild(el('span', 'ww-title-word'));
    line.setAttribute('aria-hidden', 'true');
    [...word].forEach((letter, i) => {
      const { holder, face } = piece('span', 'ww-letter', i + w);
      face.textContent = letter;
      line.appendChild(holder);
    });
  });
  title.appendChild(el('p', 'ww-card', 'A tiny explorer in your real room'));
  const begin = piece('button', 'ww-begin ww-primary', 0);
  begin.face.textContent = 'Begin';
  title.appendChild(begin.holder);
  begin.holder.onclick = () => {
    title.hidden = true;
    begin.holder.blur();
    try { localStorage.setItem(TITLE_SEEN_KEY, '1'); } catch { /* no storage: it shows again next visit */ }
  };
  function showTitle(): void {
    unfold(null);
    title.hidden = false;
    begin.holder.focus();
  }
  title.hidden = true;

  root.append(top, bottom, roomsCard, debug.el, hint, picker, drop, loading, title, statusEl);
  document.body.appendChild(root);
  if (!titleSeen()) showTitle();

  // A control clicked with the mouse must not keep the keyboard: Space is "jump",
  // not "press that button again". Keyboard users (Tab, then Enter) keep their focus.
  root.addEventListener('click', (e) => { if (e.detail > 0 && document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  addEventListener('keydown', (e) => { if (e.code === 'Escape') unfold(null); });

  return {
    debug,
    addRoom,
    setCurrentRoom,
    status,
    setLoading,
    token: (name) => getComputedStyle(root).getPropertyValue(name).trim(),
    toggleDebug() { unfold(debug.el.hidden ? debug.el : null); },
    titleOpen: () => !title.hidden,
    owns: (target) => target instanceof Node && root.contains(target),
  };
}
