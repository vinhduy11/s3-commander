// A short status message at the bottom of the window (copy and save results).

import { create } from "zustand";

const TOAST_MS = 3000;
const FAILURE_TOAST_MS = 6000;

export const useToast = create<{ message: string; ok: boolean }>(() => ({ message: "", ok: true }));

let timer: ReturnType<typeof setTimeout> | undefined;

export function showToast(message: string, ok = true): void {
  clearTimeout(timer);
  useToast.setState({ message, ok });
  timer = setTimeout(() => useToast.setState({ message: "" }), ok ? TOAST_MS : FAILURE_TOAST_MS);
}

export function ToastView() {
  const { message, ok } = useToast();
  if (!message) return null;
  return (
    <div className={ok ? "toast" : "toast failed"} role="status">
      {message}
    </div>
  );
}
