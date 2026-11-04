// SAMPLE DATA for the journal (ui/journal.ts), until the game fills it in: what each game is,
// and how it fits each example room, written by hand here from the shapes measured on the game
// branch; Play only says that games are coming. The game replaces this file with pages worked
// out from the room's shape (context/ui.md, "The journal"). Nothing else reads it.

import { hud } from '../app';
import type { JournalGame, JournalPage } from '../ui/journal';
import { currentFile } from '../scan/room';

/** The games, as a room offers them; `lava` is the one whose fit differs between the rooms. */
function games(lava: Pick<JournalGame, 'state' | 'here'>): JournalGame[] {
  return [
    { id: 'explore', name: 'Just explore', icon: 'explore', state: 'open', action: 'Explore', here: 'Here: anywhere I can reach.',
      notes: ['No goal: the room is mine to wander.', 'Climb anything I can, jump off anything I dare.', 'I can pick a game whenever I like.'] },
    { id: 'lava', name: 'The floor is lava', icon: 'lava', ...lava,
      notes: ['The floor is lava. I mustn\'t touch it.', 'Hop from top to top to reach the flag.', 'Touch the lava and I\'m back where I last stood.'] },
    { id: 'pack', name: 'The spilled pack', icon: 'pack', state: 'open', here: 'Here: my gear lands where I can reach it.',
      notes: ['My pack burst open on the way in.', 'My gear is scattered all over the room.', 'Walk into a piece to pick it up, until the pack is full.'] },
    { id: 'flood', name: 'The flood', icon: 'flood', state: 'later', here: 'Not made yet.', notes: ['The water is rising.', 'Climb before it reaches me.'] },
    { id: 'winter', name: 'The long winter', icon: 'winter', state: 'later', here: 'Not made yet.', notes: ['Every top is icy and slippery.', 'Get across without sliding off.'] },
    { id: 'volcano', name: 'The volcano', icon: 'volcano', state: 'later', here: 'Not made yet.', notes: ['One big climb, all the way to the top.'] },
    { id: 'kingdom', name: 'A kingdom on the table', icon: 'kingdom', state: 'later', here: 'Not made yet.', notes: ['A tiny kingdom, for a room that is a tabletop.'] },
  ];
}

/** Marks every sample page as one, beside the room's name. */
const SAMPLE = ' (sample page)';
const PAGES: Record<string, JournalPage> = {
  'kitchen-crop.spz': { room: `Kitchen${SAMPLE}`, games: games({ state: 'open', here: 'Here: 6 raised spots to hop, just enough. The flag is 2 of me up.' }) },
  'counter-crop.spz': { room: `Counter${SAMPLE}`, games: games({ state: 'notHere', here: 'Not here: it needs 6 raised spots to hop between, and there are 3.' }) },
  'livingroom-crop.spz': { room: `Living Room${SAMPLE}`, games: games({ state: 'open', here: 'Here: 24 raised spots to cross. The flag is 11 of me up.' }) },
  'record-player-table-crop.spz': { room: `Record Player Table${SAMPLE}`, games: games({ state: 'open', here: 'Here: 16 raised spots to cross. The flag is 15 of me up.' }) },
};
/** Any other room (an import, a test scan): nothing measured for it here. */
const OTHER: JournalPage = { room: `This room${SAMPLE}`, games: games({ state: 'notHere', here: 'Not here yet: this room has not been measured.' }) };

let shownFor = '';
/** Per frame: give the journal the page of the room in play, when the room changes. */
export function updateJournalSample(): void {
  if (currentFile === shownFor) return;
  shownFor = currentFile;
  hud.setJournal(PAGES[currentFile] ?? OTHER);
}

/** The journal's Play: there are no games yet, so it says so (Just explore needs nothing). */
export function playSampleGame(id: string): void {
  if (id !== 'explore') hud.status('Games are coming soon: this is a sample page.', 'done');
}
