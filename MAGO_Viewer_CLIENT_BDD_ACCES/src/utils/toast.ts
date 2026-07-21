/**
 * Notifications légères en bas à droite.
 */

type ToastKind = 'info' | 'error' | 'warn';

export function toast(message: string, kind: ToastKind = 'info', durationMs = 3200): void {
  const host = document.getElementById('toast-host');
  if (!host) return;

  const el = document.createElement('div');
  el.className = `toast ${kind === 'info' ? '' : kind}`;
  el.textContent = message;
  host.appendChild(el);

  setTimeout(() => {
    el.classList.add('fade');
    setTimeout(() => el.remove(), 320);
  }, durationMs);
}
