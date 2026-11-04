// The journal: the Wonderer's page for the room it is in. On the right, the games the room can
// be played as, as stamps; on the left, the game picked: what it is, in the Wonderer's own words,
// and how it fits this room (context/ui.md). What a page says comes from outside
// (hud.setJournal); this only draws it, keeps which stamp is picked, and says which game the
// player chose to play.

import { el, icon, type IconName, piece } from './paper';

/** A game the room could be played as. `notes`: what the game is, a line each. `state`: open,
 *  it can be played here; notHere, the room's shape does not suit it; later, not made yet.
 *  `here`: how it fits this room (why not, when it does not). `action` is what its button says
 *  ("Play …" when left out). */
export interface JournalGame { id: string; name: string; icon?: IconName; notes: string[]; state: 'open' | 'notHere' | 'later'; here: string; action?: string }
/** A room's page: its name and its games. */
export interface JournalPage { room: string; games: JournalGame[] }

const TAGS: Record<JournalGame['state'], string> = { open: '', notHere: 'not here', later: 'later' };

export function createJournal(onPlay: (id: string) => void): { el: HTMLElement; show(page: JournalPage | null): void } {
  const card = el('section', 'ww-card ww-journal');
  card.setAttribute('aria-label', 'Journal');
  const left = card.appendChild(el('div', 'ww-page'));
  const room = left.appendChild(el('p', 'ww-journal-room'));
  const name = left.appendChild(el('h2', 'ww-heading ww-journal-game'));
  const notes = left.appendChild(el('ul', 'ww-journal-notes'));
  const here = left.appendChild(el('p', 'ww-journal-here'));
  const right = card.appendChild(el('div', 'ww-page'));
  right.appendChild(el('h2', 'ww-heading', 'Games here'));
  const stamps = right.appendChild(el('div', 'ww-stamps'));
  const play = piece('button', 'ww-primary ww-journal-play', 2);
  right.appendChild(play.holder);

  let games: JournalGame[] = [];
  let picked: JournalGame | null = null;
  const buttons: HTMLButtonElement[] = [];
  /** Show `game` on the left page, marked on the right. */
  function pick(game: JournalGame | null): void {
    picked = game;
    games.forEach((g, i) => buttons[i].setAttribute('aria-pressed', String(g === game)));
    name.textContent = game?.name ?? '';
    notes.replaceChildren(...(game?.notes ?? []).map((n) => el('li', '', n)));
    here.textContent = game?.here ?? '';
    here.dataset.state = game?.state ?? '';
    play.face.textContent = game ? game.action ?? `Play ${game.name}` : 'Play';
    play.holder.setAttribute('aria-disabled', String(game?.state !== 'open'));
  }
  play.holder.onclick = () => { if (picked?.state === 'open') onPlay(picked.id); };

  function show(page: JournalPage | null): void {
    room.textContent = page?.room ?? '';
    const keep = picked?.id;
    games = page?.games ?? [];
    buttons.length = 0;
    stamps.replaceChildren(...games.map((g) => {
      const b = el('button', 'ww-stamp');
      b.dataset.state = g.state;
      if (g.icon) b.appendChild(icon(g.icon));
      b.append(g.name);
      if (TAGS[g.state]) b.appendChild(el('small', '', TAGS[g.state]));
      b.onclick = () => pick(g);
      buttons.push(b);
      return b;
    }));
    // the game picked before, if this page still has it open; else its first open game
    pick(games.find((g) => g.id === keep && g.state === 'open') ?? games.find((g) => g.state === 'open') ?? null);
    if (!page) name.textContent = 'Looking round…';
  }
  show(null);
  return { el: card, show };
}
