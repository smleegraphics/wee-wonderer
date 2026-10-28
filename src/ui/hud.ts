// The on-screen UI: icon tiles at the window's edge that unfold paper cards, the
// status note, and the loading and title screens. It owns its
// DOM and what is open; the app tells it what happened and is called back with
// what the player asked for. See context/ui.md.

import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource/patrick-hand-sc/400.css';
import './ui.css';
import { el, piece, tile } from './paper';
import { createDebugPanel, type DebugPanel } from './debug-panel';
import { createCreditsCard } from './credits';

/** One thing in a list to pick from: a room, a character. With an `image` it shows as that picture,
 *  and `label` becomes its name for screen readers and its tooltip. */
export interface Choice { id: string; label: string; image?: string }

export interface HudOptions {
  rooms: Choice[];
  /** The scan file types an import takes, as extensions ('.ply'). */
  importTypes: string[];
  onPickRoom(id: string): void;
  /** The characters the figurine can be (characters.ts), in the order they are listed. */
  characters: Choice[];
  onPickCharacter(id: string): void;
  onImport(file: File): void;
  onReset(): void;
}

/** busy: stays until replaced. done: clears itself. error: stays until clicked or replaced. */
export type StatusKind = 'busy' | 'done' | 'error';

export interface Hud {
  debug: DebugPanel;
  /** Add a room to the list, or rename it if it is already there. */
  addRoom(room: Choice): void;
  setCurrentRoom(id: string): void;
  setCurrentCharacter(id: string): void;
  status(message: string, kind: StatusKind): void;
  /** Show or hide the loading note (the waiting scene itself is 3D: loading-scene.ts). */
  setLoading(on: boolean): void;
  /** What the loading note says is happening, and how far the load has got (0..1). */
  loadProgress(doing: string, done: number): void;
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

/** A list to pick one thing from (the rooms, the characters): a button for each, in `list` (ahead
 *  of `before`, if given), the current one marked with aria-current. `add` of an id already listed renames it. */
function pickList(list: HTMLElement, onPick: (id: string) => void, before: HTMLElement | null = null) {
  const buttons = new Map<string, HTMLButtonElement>();
  let current = '';
  return {
    add(choice: Choice): void {
      let button = buttons.get(choice.id);
      if (!button) {
        button = el('button');
        button.onclick = () => onPick(choice.id);
        list.insertBefore(el('li'), before).appendChild(button);
        buttons.set(choice.id, button);
      }
      if (choice.image) {
        const img = button.querySelector('img') ?? button.appendChild(el('img'));
        img.src = choice.image;
        img.alt = ''; // the button carries the name
        button.setAttribute('aria-label', choice.label);
        button.title = choice.label;
      } else {
        button.textContent = choice.label;
        button.removeAttribute('aria-label');
        button.removeAttribute('title');
      }
      button.setAttribute('aria-current', String(choice.id === current));
    },
    setCurrent(id: string): void {
      current = id;
      for (const [bid, button] of buttons) button.setAttribute('aria-current', String(bid === id));
    },
  };
}

function titleSeen(): boolean {
  try { return localStorage.getItem(TITLE_SEEN_KEY) === '1'; } catch { return false; } // no storage: show it every time
}

export function createHud(opts: HudOptions): Hud {
  const root = el('div', 'ww-ui');

  // --- tiles ---
  const roomsTile = tile('rooms', 'Scans', 0);
  const charactersTile = tile('characters', 'Characters', 1);
  const resetTile = tile('reset', 'Back to the start', 1);
  const debugTile = tile('debug', 'Debug', 2);
  const controlsTile = tile('controls', 'Controls', 0);
  const creditsTile = tile('credits', 'Credits', 1);
  const top = el('div', 'ww-corner ww-corner-top');
  top.append(roomsTile, charactersTile);
  const bottom = el('div', 'ww-corner ww-corner-bottom');
  bottom.append(controlsTile, resetTile, debugTile);
  const left = el('div', 'ww-corner ww-corner-left');
  left.appendChild(creditsTile);

  // --- cards: at most one is unfolded at a time ---
  const roomsCard = el('section', 'ww-card ww-rooms');
  roomsCard.appendChild(el('h2', 'ww-heading', 'Scans'));
  const roomList = roomsCard.appendChild(el('ul', 'ww-picks'));
  const debug = createDebugPanel();
  const creditsCard = createCreditsCard();
  const controlsCard = el('section', 'ww-card ww-controls');
  controlsCard.appendChild(el('h2', 'ww-heading', 'Controls'));
  const charactersCard = el('section', 'ww-card ww-characters');
  charactersCard.appendChild(el('h2', 'ww-heading', 'Characters'));
  const characterList = charactersCard.appendChild(el('ul', 'ww-picks ww-thumbs'));
  const cards = [{ tile: roomsTile, card: roomsCard }, { tile: charactersTile, card: charactersCard }, { tile: creditsTile, card: creditsCard }, { tile: controlsTile, card: controlsCard }, { tile: debugTile, card: debug.el }];
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
  picker.accept = opts.importTypes.join(',');
  picker.hidden = true;
  picker.onchange = () => { if (picker.files?.[0]) opts.onImport(picker.files[0]); picker.value = ''; };
  const importItem = el('li');
  const importButton = importItem.appendChild(el('button', 'ww-import', '+ Import your own scan'));
  importButton.title = `A Gaussian-splat scan (${opts.importTypes.join(' or ')}). You can also drop the file on the window.`;
  importButton.onclick = () => picker.click();
  roomList.appendChild(importItem);
  const rooms = pickList(roomList, (id) => { unfold(null); opts.onPickRoom(id); }, importItem);
  opts.rooms.forEach(rooms.add);

  // --- characters list: who the figurine is ---
  const characters = pickList(characterList, (id) => { unfold(null); opts.onPickCharacter(id); });
  opts.characters.forEach(characters.add);

  // --- the controls: keys and what they do, in the Controls card (and the first two on the title) ---
  const keysLine = (into: HTMLElement, keys: string[], does: string) => {
    const line = into.appendChild(el('span', 'ww-keys'));
    for (const k of keys) line.appendChild(el('kbd', 'ww-key', k));
    line.append(does);
  };
  keysLine(controlsCard, ['W', 'A', 'S', 'D'], 'walk');
  keysLine(controlsCard, ['Shift'], 'run');
  keysLine(controlsCard, ['Space'], 'jump');
  keysLine(controlsCard, [], 'walk into a wall to climb');

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

  // --- drop a scan anywhere to import it ---
  const drop = el('div', 'ww-screen ww-drop');
  drop.appendChild(el('div', 'ww-card', 'Drop a scan to import'));
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
  const note = loading.appendChild(el('div', 'ww-card'));
  const doing = note.appendChild(el('p'));
  const meter = note.appendChild(el('div', 'ww-progress'));
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.appendChild(el('i')); // the track; its fill is drawn from --done
  const percent = meter.appendChild(el('output'));
  function loadProgress(what: string, done: number): void {
    const part = Math.min(1, Math.max(0, done));
    doing.textContent = `${what}…`;
    meter.setAttribute('aria-valuenow', String(Math.round(part * 100)));
    meter.style.setProperty('--done', String(part));
    percent.textContent = `${Math.round(part * 100)}%`;
  }
  loadProgress('Building the room', 0); // until the app names the first step
  function setLoading(on: boolean): void {
    loading.dataset.on = String(on);
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
  // The figurine moves by keyboard only, so a touch screen says so up front (shown by ui.css on touch-only devices).
  title.appendChild(el('p', 'ww-card ww-touch-note', 'Best on a computer with a keyboard'));
  // The controls are folded away in play, so the title says how to move (not on a touch screen, which has no keys: ui.css).
  const keysNote = title.appendChild(el('p', 'ww-card ww-keys-note'));
  keysLine(keysNote, ['W', 'A', 'S', 'D'], 'to walk');
  keysLine(keysNote, ['Space'], 'to jump');
  const begin = piece('button', 'ww-begin ww-primary', 0);
  begin.face.textContent = 'Begin';
  title.appendChild(begin.holder);
  begin.holder.onclick = () => {
    title.hidden = true;
    begin.holder.blur(); // showTitle gave it the focus, and a Begin pressed with Enter is not a mouse click, so the root's handler below does not take it back
    try { localStorage.setItem(TITLE_SEEN_KEY, '1'); } catch { /* no storage: it shows again next visit */ }
  };
  function showTitle(): void {
    unfold(null);
    title.hidden = false;
    begin.holder.focus();
  }
  title.hidden = true;

  root.append(top, bottom, left, roomsCard, charactersCard, creditsCard, controlsCard, debug.el, picker, drop, loading, title, statusEl);
  document.body.appendChild(root);
  if (!titleSeen()) showTitle();

  // A control clicked with the mouse must not keep the keyboard: Space is "jump",
  // not "press that button again". Keyboard users (Tab, then Enter) keep their focus.
  root.addEventListener('click', (e) => { if (e.detail > 0 && document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  addEventListener('keydown', (e) => { if (e.code === 'Escape') unfold(null); });

  return {
    debug,
    addRoom: rooms.add,
    setCurrentRoom: rooms.setCurrent,
    setCurrentCharacter: characters.setCurrent,
    status,
    setLoading,
    loadProgress,
    token: (name) => getComputedStyle(root).getPropertyValue(name).trim(),
    toggleDebug() { unfold(debug.el.hidden ? debug.el : null); },
    titleOpen: () => !title.hidden,
    owns: (target) => target instanceof Node && root.contains(target),
  };
}
