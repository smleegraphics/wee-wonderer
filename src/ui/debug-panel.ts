// The Debug card: tunables grouped into collapsible sections, with the help for
// whichever control is under the pointer pinned at the bottom of the card.

import { el } from './paper';

export interface DebugSection {
  /** A checkbox row; returns the input so callers can keep it in sync. */
  addToggle(label: string, initial: boolean, onChange: (v: boolean) => void, help?: string): HTMLInputElement;
  /** A labelled slider with a live value readout; fires `onChange` on release. */
  addSlider(label: string, initial: number, min: number, max: number, step: number, onChange: (v: number) => void, help?: string): void;
}

export interface DebugPanel {
  el: HTMLElement;
  /** Start a new section; controls are added to it through the returned object. */
  section(name: string, open?: boolean): DebugSection;
}

const HELP_IDLE = 'Point at a control to see what it does.';

export function createDebugPanel(): DebugPanel {
  const card = el('section', 'ww-card ww-debug');
  card.appendChild(el('h2', 'ww-heading', 'Debug'));
  const sections = card.appendChild(el('div', 'ww-debug-sections'));
  // Every control's help lives in the strip at once, stacked in one grid cell with
  // only one visible. The strip is therefore as tall as the longest help and never
  // resizes or scrolls as the pointer moves from control to control.
  const helpEl = card.appendChild(el('div', 'ww-debug-help'));
  const idle = helpEl.appendChild(el('div', '', HELP_IDLE));
  let shown: HTMLElement = idle;
  function show(note: HTMLElement): void {
    delete shown.dataset.on;
    shown = note;
    shown.dataset.on = '';
  }
  show(idle);

  /** Show `help` in the pinned strip while `row` is hovered or `control` has focus. */
  function describe(row: HTMLElement, control: HTMLElement, help: string | undefined): void {
    if (!help) return;
    const note = helpEl.appendChild(el('div', '', help));
    row.addEventListener('pointerenter', () => show(note));
    row.addEventListener('pointerleave', () => show(idle));
    control.addEventListener('focus', () => show(note));
    control.addEventListener('blur', () => show(idle));
  }

  function section(name: string, open = false): DebugSection {
    const details = sections.appendChild(el('details'));
    details.open = open;
    const summary = details.appendChild(el('summary', '', name));
    const count = summary.appendChild(el('span', 'ww-debug-count', '0'));
    const rows = details.appendChild(el('div', 'ww-debug-rows'));
    const add = (row: HTMLElement) => { rows.appendChild(row); count.textContent = String(rows.childElementCount); };

    return {
      addToggle(label, initial, onChange, help) {
        const row = el('label', 'ww-debug-row');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.checked = initial;
        cb.onchange = () => onChange(cb.checked);
        row.append(el('span', '', label), cb);
        describe(row, cb, help);
        add(row);
        return cb;
      },
      addSlider(label, initial, min, max, step, onChange, help) {
        const decimals = (String(step).split('.')[1] ?? '').length; // show as many places as the step can change
        const row = el('label', 'ww-debug-row');
        const readout = el('output', '', initial.toFixed(decimals));
        const slider = el('input');
        slider.type = 'range';
        slider.min = String(min); slider.max = String(max); slider.step = String(step);
        slider.value = String(initial);
        slider.setAttribute('aria-label', label); // its name is the label alone, not label + readout
        slider.oninput = () => { readout.textContent = Number(slider.value).toFixed(decimals); };
        slider.onchange = () => onChange(Number(slider.value));
        row.append(el('span', '', label), readout, slider);
        describe(row, slider, help);
        add(row);
      },
    };
  }

  return { el: card, section };
}
