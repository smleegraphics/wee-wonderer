// The Credits card: who made what the visitor is looking at, with the licences that ask
// for credit (CC BY 4.0: the Chibi figurine and the Mip-NeRF 360 scenes). CREDITS.md at the
// repository's root says the same at more length; keep the two in step.

import { el } from './paper';

type Part = string | { text: string; href: string };
interface Credit { what: string; who: Part[]; note?: Part[] }

const CC_BY = { text: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' };
const CC0 = { text: 'CC0', href: 'https://creativecommons.org/publicdomain/zero/1.0/' };

const CREDITS: Credit[] = [
  { what: 'Made by', who: [{ text: 'Samantha Lee', href: 'https://samanthamlee.com' }] },
  {
    what: 'Chibi',
    who: [{ text: 'Free Pack – Chibi Base Mesh (Rigged)', href: 'https://sketchfab.com/3d-models/free-pack-chibi-base-mesh-rigged-fed4fb329f224f1594f631eae8d2626b' }, ' by PolyOne Studio, ', CC_BY, ', adapted'],
    note: ['Animations from ', { text: 'Mixamo', href: 'https://www.mixamo.com' }],
  },
  { what: 'Robot', who: [{ text: 'RobotExpressive', href: 'https://github.com/mrdoob/three.js/tree/dev/examples/models/gltf/RobotExpressive' }, ' by Tomás Laulhé (Quaternius), ', CC0] },
  { what: 'Human', who: [{ text: 'Animated Human', href: 'https://opengameart.org/content/animated-human-low-poly' }, ' by Quaternius, ', CC0] },
  {
    what: 'Kitchen, Living Room and Counter',
    who: ['From the ', { text: 'Mip-NeRF 360', href: 'https://jonbarron.info/mipnerf360/' }, ' dataset by Barron, Mildenhall, Verbin, Srinivasan and Hedman (Google), ', CC_BY],
    note: ['Trained into splats with msplat by ', { text: 'alexmkwizu', href: 'https://huggingface.co/datasets/alexmkwizu/gaussian_training_datasets' }, ', then cleaned and converted for this site'],
  },
  { what: 'Curled Up Dog', who: ['Captured by Samantha Lee'] },
  { what: 'Type', who: ['Pixelify Sans and Patrick Hand SC, ', { text: 'SIL Open Font License', href: 'https://openfontlicense.org' }] },
  { what: 'Built with', who: [{ text: 'three.js', href: 'https://threejs.org' }] },
];

function line(className: string, parts: Part[]): HTMLParagraphElement {
  const p = el('p', className);
  for (const part of parts) {
    if (typeof part === 'string') { p.append(part); continue; }
    const a = p.appendChild(el('a', '', part.text));
    a.href = part.href;
    a.target = '_blank';
    a.rel = 'noopener';
  }
  return p;
}

/** The card, folded until its tile is pressed (the HUD unfolds one card at a time). */
export function createCreditsCard(): HTMLElement {
  const card = el('section', 'ww-card ww-credits');
  card.appendChild(el('h2', 'ww-heading', 'Credits'));
  const list = card.appendChild(el('dl'));
  for (const c of CREDITS) {
    list.appendChild(el('dt', '', c.what));
    const dd = list.appendChild(el('dd'));
    dd.appendChild(line('', c.who));
    if (c.note) dd.appendChild(line('ww-credit-note', c.note));
  }
  return card;
}
