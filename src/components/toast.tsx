"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type Toast = {
  id: string;
  message: string;
  tone: "success" | "error";
  /** Shown as an Undo button while the toast is up. */
  action?: { label: string; run: () => Promise<void> | void };
  /** Milliseconds. The spec asks for roughly 30s on the take-out confirmation. */
  duration?: number;
};

type ToastContextValue = {
  show: (toast: Omit<Toast, "id">) => void;
  dismiss: (id: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside <ToastProvider>");
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (toast: Omit<Toast, "id">) => {
      const id = crypto.randomUUID();
      const duration = toast.duration ?? (toast.action ? 30_000 : 4_000);

      // One at a time: this is a phone screen, and a stack of toasts would
      // cover the search results the user is trying to read.
      setToasts([{ ...toast, id }]);

      timers.current.set(
        id,
        setTimeout(() => dismiss(id), duration),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="true"
        // Sits above the bottom nav on a phone rather than on top of it; on
        // desktop there is no nav down there to clear.
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6"
      >
        {toasts.map((toast) => (
          <ToastRow key={toast.id} toast={toast} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border px-4 py-3 shadow-(--shadow-panel) ${
        toast.tone === "error"
          ? "border-danger/40 bg-danger text-white"
          : "border-border bg-surface text-foreground"
      }`}
    >
      <p className="flex-1 text-sm font-medium">{toast.message}</p>

      {toast.action ? (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await toast.action?.run();
            } finally {
              onDismiss(toast.id);
            }
          }}
          className="min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold text-accent-text underline-offset-2 hover:underline disabled:opacity-50"
        >
          {busy ? "…" : toast.action.label}
        </button>
      ) : null}

      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
        className="min-h-11 min-w-11 shrink-0 text-lg opacity-60"
      >
        ×
      </button>
    </div>
  );
}
