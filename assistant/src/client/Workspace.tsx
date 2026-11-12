import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { BASE, type Intent, intentKey, ticketFor } from "./api";

interface WorkspaceValue {
  pages: Intent[];
  active: string | null;
  open: (intent: Intent) => void;
  close: (key: string) => void;
  show: (key: string) => void;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace outside WorkspaceProvider");
  return value;
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [pages, setPages] = useState<Intent[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const open = useCallback((intent: Intent) => {
    const key = intentKey(intent);
    setPages((current) => (current.some((page) => intentKey(page) === key) ? current : [...current, intent]));
    setActive(key);
  }, []);

  const close = useCallback((key: string) => {
    setPages((current) => {
      const next = current.filter((page) => intentKey(page) !== key);
      setActive((was) => (was === key ? (next.length ? intentKey(next[next.length - 1] as Intent) : null) : was));
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ pages, active, open, close, show: setActive }),
    [pages, active, open, close]
  );
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/**
 * One application page, inside the chat.
 *
 * The frame is never given an address. It asks for a ticket for the intent,
 * and loads the ticket; the server answers that with a redirect to the page.
 * A ticket works once, so reloading the frame means asking for another — and
 * being checked again.
 */
function AppFrame({ intent, hidden }: { intent: Intent; hidden: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ ticket: string } | "loading" | "unavailable">("loading");

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    void ticketFor(intent).then((ticket) => {
      if (!cancelled) setState(ticket ? { ticket } : "unavailable");
    });
    return () => {
      cancelled = true;
    };
    // `attempt` is the reload button.
  }, [intent, attempt]);

  return (
    <section className="frame" hidden={hidden} aria-label={intent.title}>
      <div className="frame-bar">
        <span className="frame-product">{intent.product === "report" ? "Reporting" : "Application"}</span>
        <button type="button" className="link" onClick={() => setAttempt((n) => n + 1)}>
          Reload
        </button>
      </div>
      {state === "loading" && <p className="frame-note">Opening…</p>}
      {state === "unavailable" && (
        <p className="frame-note">This page is not available to you, or it no longer exists.</p>
      )}
      {typeof state === "object" && (
        <iframe
          key={state.ticket}
          title={intent.title}
          src={`${BASE}/open/${state.ticket}`}
          referrerPolicy="no-referrer"
        />
      )}
    </section>
  );
}

export function Workspace() {
  const { pages, active, close, show } = useWorkspace();

  if (pages.length === 0) {
    return (
      <div className="workspace workspace-empty">
        <div>
          <h2>Nothing open yet</h2>
          <p>Ask for a record, a list, a report or a dashboard and it opens here.</p>
          <ul>
            <li>“Find the Acme account and open it”</li>
            <li>“Show me what is waiting for me”</li>
            <li>“Open the dashboard for my role”</li>
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div className="workspace">
      <div className="tabs" role="tablist">
        {pages.map((page) => {
          const key = intentKey(page);
          return (
            <div key={key} className={key === active ? "tab tab-active" : "tab"}>
              <button type="button" role="tab" aria-selected={key === active} onClick={() => show(key)}>
                {page.title}
              </button>
              <button type="button" className="tab-close" aria-label={`Close ${page.title}`} onClick={() => close(key)}>
                ×
              </button>
            </div>
          );
        })}
      </div>
      {pages.map((page) => {
        const key = intentKey(page);
        return <AppFrame key={key} intent={page} hidden={key !== active} />;
      })}
    </div>
  );
}
