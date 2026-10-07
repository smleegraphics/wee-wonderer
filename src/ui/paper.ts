// The cut-paper building blocks every piece of UI is made from (styles in ui.css).

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Icons: one flat glyph each, drawn in a 24-unit box and filled with the ink colour. */
export const ICONS = {
  rooms: 'M12 3 2.5 11H5v9h5.5v-6h3v6H19v-9h2.5z',
  reset: 'M12 5V1.5L6.5 6.5 12 11.5V8a5 5 0 1 1-5 5H4a8 8 0 1 0 8-8z',
  debug: 'M21 6.5a5 5 0 0 1-6.6 4.7L6.6 19a2 2 0 0 1-2.8-2.8l7.8-7.8A5 5 0 0 1 17.5 3l-3 3 .7 2.8 2.8.7z',
} as const;

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
export function tile(icon: keyof typeof ICONS, label: string, cut: number): HTMLButtonElement {
  const { holder, face } = piece('button', 'ww-tile', cut);
  holder.title = label;
  holder.setAttribute('aria-label', label);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[icon]);
  svg.appendChild(path);
  face.appendChild(svg);
  return holder;
}
