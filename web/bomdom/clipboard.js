// Clipboard: put a part number where the user can paste it (issue #32).
// navigator.clipboard needs a secure context — file:// and https qualify,
// a plain http:// share does not — so a hidden-textarea execCommand copy
// stays as the fallback. Both paths must run inside the user's click.

export async function copyText(text) {
  const value = String(text == null ? '' : text);
  if (!value) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) {
    // Denied or unavailable — try the legacy path below.
  }
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, value.length);
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  ta.remove();
  return ok;
}

// One line for one part number, one per line for several — pastes cleanly
// into a spreadsheet column or a search box either way.
export function joinPartNumbers(names) {
  return [...new Set(names.filter(Boolean))].join('\n');
}

export function copiedToast(names) {
  const uniq = [...new Set(names.filter(Boolean))];
  if (uniq.length === 1) return `Copied ${uniq[0]}`;
  return `Copied ${uniq.length} part numbers`;
}
