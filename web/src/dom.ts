/**
 * Tiny DOM helpers. All text goes through textContent — never innerHTML —
 * so user-influenced strings (titles, annotation text) can never become
 * markup (CLAUDE.md rule 5). ESLint also blocks innerHTML repo-wide.
 */

type Handlers = {
  [K in keyof HTMLElementEventMap]?: (this: HTMLElement, ev: HTMLElementEventMap[K]) => void;
};

export interface ElProps {
  text?: string;
  className?: string;
  /** Plain attributes; values are set via setAttribute (never parsed as HTML). */
  attrs?: Record<string, string>;
  on?: Handlers;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.className !== undefined) node.className = props.className;
  for (const [name, value] of Object.entries(props.attrs ?? {})) node.setAttribute(name, value);
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    node.addEventListener(type, handler as EventListener);
  }
  node.append(...children);
  return node;
}

/** Replace the contents of `#app` (or any root) with the given nodes. */
export function mount(root: HTMLElement, ...children: Array<Node | string>): void {
  root.replaceChildren(...children);
}

/** Show a short transient label on a button (e.g. "Copied") then restore it. */
export function flash(button: HTMLButtonElement, label: string, ms = 1500): void {
  const original = button.textContent;
  button.textContent = label;
  button.disabled = true;
  window.setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, ms);
}

/** Copy text to the clipboard; falls back to selecting a provided input. */
export async function copyText(text: string, fallback?: HTMLInputElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (fallback) {
      fallback.focus();
      fallback.select();
    }
    return false;
  }
}
