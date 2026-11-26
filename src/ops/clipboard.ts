// Copy text to the clipboard from inside a click handler. The async Clipboard API first; when it
// is missing or refuses (some webviews), select the text in a throwaway textarea and use
// document.execCommand("copy"). Returns whether either worked.

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the selection fallback
  }
  return copyBySelection(text);
}

function copyBySelection(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.className = "clipboard-field";
  document.body.append(field);
  const restoreFocus = document.activeElement as HTMLElement | null;
  field.focus();
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    restoreFocus?.focus?.();
  }
}
