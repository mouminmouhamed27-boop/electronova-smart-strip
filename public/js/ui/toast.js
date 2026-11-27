/**
 * Accessible Top Toast Notification Helper (XSS-safe textContent)
 */

const ICONS = {
  ok: 'fa-circle-check',
  warn: 'fa-triangle-exclamation',
  bad: 'fa-circle-xmark',
  info: 'fa-circle-info'
};

export function showToast(message, level = 'info', durationMs = 3200) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${level}`;

  const icon = document.createElement('i');
  icon.className = `fa-solid ${ICONS[level] || ICONS.info}`;

  const msgSpan = document.createElement('span');
  msgSpan.textContent = String(message);

  toast.appendChild(icon);
  toast.appendChild(msgSpan);
  container.appendChild(toast);

  while (container.children.length > 3) {
    container.removeChild(container.firstElementChild);
  }

  setTimeout(() => {
    toast.remove();
  }, durationMs);
}
