/**
 * Tiny DOM helpers. All text goes through textContent — never innerHTML —
 * so user-influenced strings (titles, annotation text) can never become
 * markup (CLAUDE.md rule 5). ESLint also blocks innerHTML repo-wide.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { text?: string; className?: string } = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.className !== undefined) node.className = props.className;
  node.append(...children);
  return node;
}
