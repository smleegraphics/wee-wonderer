// The cut-paper building blocks every piece of UI is made from (styles in ui.css).

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icons: one flat glyph each, drawn in a 24-unit box and filled with the ink colour.
 *  Filled even-odd, so a shape inside another is a hole (the keyboard's keys). */
export const ICONS = {
  rooms: 'M12 3 2.5 11H5v9h5.5v-6h3v6H19v-9h2.5z',
  characters: 'M12 2.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4.5 21.5c0-4.4 3.4-8 7.5-8s7.5 3.6 7.5 8z',
  reset: 'M12 5V1.5L6.5 6.5 12 11.5V8a5 5 0 1 1-5 5H4a8 8 0 1 0 8-8z',
  debug: 'M21 6.5a5 5 0 0 1-6.6 4.7L6.6 19a2 2 0 0 1-2.8-2.8l7.8-7.8A5 5 0 0 1 17.5 3l-3 3 .7 2.8 2.8.7z',
  credits: 'M12 21s-7.5-4.6-9.4-9A5.2 5.2 0 0 1 12 6.6 5.2 5.2 0 0 1 21.4 12c-1.9 4.4-9.4 9-9.4 9z',
  controls: 'M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4.5 8v2h2V8zm3.5 0v2h2V8zm3.5 0v2h2V8zm3.5 0v2h2V8zm3.5 0v2h2V8zM6 11.5v2h2v-2zm3.5 0v2h2v-2zm3.5 0v2h2v-2zm3.5 0v2h2v-2zM7 15v2h10v-2z',
  info: 'M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19zM10.8 10.2h2.4v7.3h-2.4zM12 5.9a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  journal: 'M2.5 5c3.2-1.3 6.6-1.1 8.8.7v14.4c-2.2-1.6-5.6-1.8-8.8-.7zM21.5 5c-3.2-1.3-6.6-1.1-8.8.7v14.4c2.2-1.6 5.6-1.8 8.8-.7z',
  // the journal's stamps: one for each game a room can be played as
  explore: 'M12 2.5a9.5 9.5 0 1 1 0 19 9.5 9.5 0 0 1 0-19zM12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM15.8 8.2l-2.3 5.3-5.3 2.3 2.3-5.3z',
  lava: 'M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3.5 2-5 2.5-8 1.5 1.2 2.3 2.8 2.3 4.6C12 9 12.5 6 12 2z',
  pack: 'M8 5V3.5h8V5h.5A3.5 3.5 0 0 1 20 8.5V20a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 20V8.5A3.5 3.5 0 0 1 7.5 5zM9.5 5h5V4.5h-5zM8 13v6h8v-6z',
  flood: 'M2 8.5c2.5-2 5-2 7.5 0s5 2 7.5 0c1.5-1.2 3.5-1.5 5-1v3c-1.5-.5-2.5 0-5 1.5s-5 1.5-7.5 0-5-1.5-7.5 0zM2 14.5c2.5-2 5-2 7.5 0s5 2 7.5 0c1.5-1.2 3.5-1.5 5-1v3c-1.5-.5-2.5 0-5 1.5s-5 1.5-7.5 0-5-1.5-7.5 0z',
  winter: 'M12 2l2 6.5 6.7-1.5-4.7 5 4.7 5-6.7-1.5-2 6.5-2-6.5-6.7 1.5 4.7-5-4.7-5 6.7 1.5z',
  volcano: 'M2 21l7-12h6l7 12zM10 6.5V4.5c0-1.4 1-2.5 2-2.5s2 1.1 2 2.5v2z',
  kingdom: 'M3 18.5l1.5-11 5 5 2.5-7 2.5 7 5-5 1.5 11z',
} as const;
export type IconName = keyof typeof ICONS;

/** An icon on its own (aria-hidden: whatever it is on carries the name). */
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill-rule', 'evenodd');
  svg.appendChild(path);
  return svg;
}

/** The three cuts in ui.css. Pass a running index so neighbours get different ones. */
const CUTS = ['ww-cut-a', 'ww-cut-b', 'ww-cut-c'] as const;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** A shadow-casting holder with a cut face inside it; content goes in `face`. */
export function piece<K extends 'button' | 'span'>(tag: K, className: string, cut: number): { holder: HTMLElementTagNameMap[K]; face: HTMLSpanElement } {
  const holder = el(tag, `ww-piece ${CUTS[cut % CUTS.length]} ${className}`);
  const face = el('span', 'ww-face');
  holder.appendChild(face);
  return { holder, face };
}

/** A square icon button. `label` is what it is called (tooltip and screen readers). */
export function tile(name: IconName, label: string, cut: number): HTMLButtonElement {
  const { holder, face } = piece('button', 'ww-tile', cut);
  holder.title = label;
  holder.setAttribute('aria-label', label);
  face.appendChild(icon(name));
  return holder;
}
