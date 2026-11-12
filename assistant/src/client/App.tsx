import { CopilotChat, CopilotKitProvider, useRenderTool } from "@copilotkit/react-core/v2";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { BASE, type Intent, loadSession, type Session, type SessionState, signIn, signOut } from "./api";
import { useWorkspace, Workspace, WorkspaceProvider } from "./Workspace";

const OPEN_TOOLS = ["open_record", "open_page", "open_report"] as const;

const LABELS: Record<string, string> = {
  find_pages: "Looking at what you can open",
  search_records: "Searching records",
  get_record: "Reading the record",
  list_my_work: "Checking what is waiting for you",
  search_reports: "Searching reports",
  run_report: "Running the report",
};

function parseResult(result: unknown): any {
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result);
  } catch {
    return null;
  }
}

/** The chip a completed "open" tool leaves in the conversation. Opens the page once, then offers it again. */
function OpenedChip({ result }: { result: unknown }) {
  const workspace = useWorkspace();
  const parsed = parseResult(result);
  const intent: Intent | null = parsed?.available === true ? parsed.opened : null;
  const done = useRef(false);

  useEffect(() => {
    if (intent && !done.current) {
      done.current = true;
      workspace.open(intent);
    }
  }, [intent, workspace]);

  if (!intent) return <div className="aw-chip aw-chip-refused">Not available to you</div>;
  return (
    <button type="button" className="aw-chip aw-chip-open" onClick={() => workspace.open(intent)}>
      Opened: {intent.title}
    </button>
  );
}

function ToolRenderers() {
  for (const name of OPEN_TOOLS) {
    // The list is fixed, so the hooks run in the same order on every render.
    useRenderTool(
      {
        name,
        parameters: z.object({ title: z.string().optional() }).passthrough(),
        render: (props) =>
          props.status === "complete" ? (
            <OpenedChip result={props.result} />
          ) : (
            <div className="aw-chip">Opening {props.parameters?.title ?? "…"}</div>
          ),
      },
      []
    );
  }
  useRenderTool(
    {
      name: "*",
      render: ({ name, status }: { name: string; status: string }) => (
        <div className="aw-chip">
          {LABELS[name] ?? name}
          {status === "complete" ? " — done" : "…"}
        </div>
      ),
    },
    []
  );
  return null;
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(await signIn(String(form.get("email") ?? ""), String(form.get("password") ?? "")));
    setBusy(false);
    onDone();
  };

  return (
    <main className="gate">
      <form className="card" onSubmit={submit}>
        <h1>Sign in</h1>
        <p className="muted">Use your application account. What you can reach here is what that account can reach.</p>
        <label>
          E-mail
          <input name="email" type="email" autoComplete="username" required />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="gate">
      <div className="card">
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

function Shell({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  return (
    <CopilotKitProvider runtimeUrl={`${BASE}/api/copilotkit`} credentials="same-origin">
      <WorkspaceProvider>
        <ToolRenderers />
        <div className="shell">
          <header className="top">
            <strong>{session.appName}</strong>
            <span className="muted">Assistant</span>
            <span className="spacer" />
            <span className="muted">{session.user.name}</span>
            <button type="button" className="link" onClick={onSignOut}>
              Sign out
            </button>
          </header>
          <aside className="chat">
            <CopilotChat
              labels={{
                chatInputPlaceholder: "Ask for a record, a page or a report…",
                welcomeMessageText: `Hello ${session.user.name}. What would you like to open?`,
              }}
            />
          </aside>
          <Workspace />
        </div>
      </WorkspaceProvider>
    </CopilotKitProvider>
  );
}

export function App() {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const refresh = () => void loadSession().then(setState);

  useEffect(() => {
    refresh();
    // Renews the embed cookie while the chat is open, and notices a sign-out or a switch-off.
    const timer = setInterval(refresh, 4 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  if (state.status === "loading") return <Notice title="Loading…">{null}</Notice>;
  if (state.status === "unreachable") {
    return (
      <Notice title="We couldn't check your sign-in">
        <p className="muted">The application is not answering. Your session has not been ended.</p>
        <button type="button" className="primary" onClick={refresh}>
          Try again
        </button>
      </Notice>
    );
  }
  if (state.status === "signedOut") return <SignIn onDone={refresh} />;
  if (!state.session.enabled) {
    return (
      <Notice title="The assistant is switched off">
        <p className="muted">An administrator can switch it on under Admin → System Config.</p>
      </Notice>
    );
  }
  return <Shell session={state.session} onSignOut={() => void signOut().then(refresh)} />;
}
