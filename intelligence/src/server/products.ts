/**
 * The two products, reached as the signed-in person and nobody else.
 *
 * Nothing here decides access. Every call carries that person's own session,
 * so the generated application's guards and the reporting platform's
 * permission checks give the answer; a refusal from either is passed on as a
 * refusal. There is no service account and no elevated path.
 */
import type { AssistantConfig } from "./config";
import { signStatement } from "./signing";

export class ProductError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** The person, as the generated application describes them. */
export interface Person {
  email: string;
  name: string;
  roles: string[];
  isMaster: boolean;
}

export interface EntityInfo {
  /** Storage key, e.g. `bus_account`. Used in addresses and API calls, never shown. */
  table: string;
  /** The label a person sees, e.g. "Account". */
  label: string;
  description: string;
}

export interface AdminPage {
  label: string;
  route: string;
}

export interface ChatSwitches {
  enabled: boolean;
  chatOnly: boolean;
  appName: string;
}

const SAFE_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isSafeName = (value: unknown): value is string =>
  typeof value === "string" && SAFE_NAME.test(value);
export const isSafeId = (value: unknown): value is string =>
  typeof value === "string" && SAFE_ID.test(value);

async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The header that tells the application a call is the assistant's own. In
 * chat-only mode the application answers only requests that came through the
 * assistant; a page in the frame carries the embed cookie, and the assistant's
 * server-side calls carry this. It names nobody and grants nothing — the
 * person's session cookie, sent beside it, is still what every guard reads.
 */
export const BRIDGE_HEADER = "x-chat-bridge";

let bridge: { until: number; value: string } | null = null;

async function bridgeStatement(config: AssistantConfig): Promise<string> {
  if (bridge && bridge.until > Date.now()) return bridge.value;
  const value = await signStatement(config.bridgeSecret, { aud: "bridge", sub: "assistant" }, 300);
  bridge = { until: Date.now() + 240_000, value };
  return value;
}

/** The generated application's API, called with one person's session cookie. */
export class AppClient {
  constructor(
    private readonly config: AssistantConfig,
    private readonly cookie: string
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    const response = await fetch(`${this.config.appApiUrl}/api${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        cookie: this.cookie,
        origin: this.config.publicOrigin,
        [BRIDGE_HEADER]: await bridgeStatement(this.config),
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const body = await readJson(response);
    if (!response.ok) {
      const message = body?.message ?? body?.error ?? response.statusText;
      throw new ProductError(response.status, typeof message === "string" ? message : "Refused");
    }
    return body;
  }

  async me(): Promise<Person | null> {
    try {
      const body = await this.call("/me");
      const user = body?.data;
      if (!user?.email) return null;
      const permissions = await this.call("/me/permissions").catch(() => null);
      const roles: string[] = Array.isArray(user.sysRoles)
        ? user.sysRoles
        : permissions?.access?.roles ?? [];
      return {
        email: String(user.email).toLowerCase(),
        name: String(user.name ?? user.email),
        roles: roles.map(String),
        isMaster: user.isMaster === true || permissions?.isMaster === true,
      };
    } catch (error) {
      if (error instanceof ProductError && (error.status === 401 || error.status === 403)) return null;
      throw error;
    }
  }

  async switches(): Promise<ChatSwitches> {
    const info = await this.call("/sys/app-info");
    return {
      // An application generated before the switches existed has neither key;
      // the container being deployed is then the whole decision.
      enabled: info?.chatEnabled !== false,
      chatOnly: info?.chatOnlyMode === true,
      appName: String(info?.name ?? "Application"),
    };
  }

  /** The business entities this person may read. The application scopes the list. */
  async entities(): Promise<EntityInfo[]> {
    const body = await this.call("/sys/tables?prefix=bus_&limit=500");
    const rows: any[] = Array.isArray(body) ? body : (body?.data ?? []);
    return rows
      .filter((row) => isSafeName(row?.table_name))
      .map((row) => ({
        table: row.table_name as string,
        label: String(row.name ?? row.table_name),
        description: String(row.description ?? ""),
      }));
  }

  async adminPages(): Promise<AdminPage[]> {
    const body = await this.call("/me/permissions");
    const windows: any[] = body?.windows ?? [];
    return windows
      .filter((w) => w?.category === "admin" && typeof w.route === "string" && w.route.startsWith("/"))
      .map((w) => ({ label: String(w.name), route: String(w.route) }));
  }

  async list(
    table: string,
    query: { search?: string; awaiting?: boolean; limit?: number }
  ): Promise<{ rows: any[]; total: number }> {
    const params = new URLSearchParams({ limit: String(Math.min(query.limit ?? 10, 50)) });
    if (query.search) params.set("search", query.search);
    if (query.awaiting) params.set("awaiting", "me");
    const body = await this.call(`/bus/${table}?${params}`);
    return { rows: body?.data ?? [], total: Number(body?.meta?.total ?? body?.data?.length ?? 0) };
  }

  async record(table: string, id: string): Promise<any> {
    const body = await this.call(`/bus/${table}/${id}`);
    return body?.data ?? body;
  }

  /** The moves this person may press on the record now. */
  async actions(table: string, id: string): Promise<{ event: string; to: string; label: string }[]> {
    const body = await this.call(`/bus/${table}/${id}/actions`);
    const rows: any[] = Array.isArray(body) ? body : (body?.data ?? []);
    return rows
      .filter((row) => typeof row?.event === "string")
      .map((row) => ({ event: row.event, to: String(row.to ?? ""), label: String(row.label ?? row.event) }));
  }

  /** Press an action button, naming the version the record was read at. */
  async move(table: string, id: string, event: string, version: number): Promise<void> {
    await this.call(`/bus/${table}/${id}/transition`, {
      method: "POST",
      headers: { "if-match": `"${version}"` },
      body: JSON.stringify({ event }),
    });
  }

  /** Save some fields, naming the version the record was read at. */
  async update(table: string, id: string, data: Record<string, unknown>, version: number): Promise<void> {
    await this.call(`/bus/${table}/${id}`, {
      method: "PATCH",
      headers: { "if-match": `"${version}"` },
      body: JSON.stringify(data),
    });
  }
}

/** The reporting platform, called with a session delegated for one person. */
export class ReportClient {
  constructor(
    private readonly config: AssistantConfig,
    private readonly session: ReportSession
  ) {}

  private async call(path: string, init: RequestInit = {}): Promise<any> {
    const response = await fetch(`${this.config.reportUrl}${this.config.reportBasePath}/api${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        cookie: this.session.cookie,
        origin: this.config.publicOrigin,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const body = await readJson(response);
    if (!response.ok) {
      const message = body?.error?.message ?? body?.error ?? body?.message ?? response.statusText;
      throw new ProductError(response.status, typeof message === "string" ? message : "Refused");
    }
    return body;
  }

  async search(query: string, limit = 10): Promise<any[]> {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    const body = await this.call(`/search?${params}`);
    return body?.items ?? [];
  }

  async definition(kind: "report" | "chart" | "dashboard", id: string): Promise<any> {
    const collection = { report: "reports", chart: "charts", dashboard: "dashboards" }[kind];
    return this.call(`/${collection}/${id}`);
  }

  async reportData(id: string, pageSize = 20): Promise<any> {
    return this.call(`/reports/${id}/data?page=0&pageSize=${pageSize}`);
  }
}

export interface ReportSession {
  /** `name=value`, ready for a `Cookie` request header. */
  cookie: string;
  /** Complete `Set-Cookie` headers, relayed to the browser when a reporting page is opened. */
  setCookie: string[];
  expiresAt: number;
}

/**
 * Ask the reporting platform for a session for this person.
 *
 * The assertion names them and their application roles, read from the
 * application a moment ago — never from the browser. The platform creates the
 * person on first use and gives them the reporting roles of the same names.
 */
export async function delegateReportSession(
  config: AssistantConfig,
  person: Person
): Promise<ReportSession> {
  const assertion = await signStatement(
    config.bridgeSecret,
    {
      aud: "report-delegate",
      sub: person.email,
      name: person.name,
      roles: person.roles,
      admin: person.isMaster,
    },
    60
  );
  const response = await fetch(`${config.reportUrl}${config.reportBasePath}/api/chat/delegate`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: config.publicOrigin },
    body: JSON.stringify({ assertion }),
  });
  const body = await readJson(response);
  if (!response.ok || !Array.isArray(body?.setCookie) || body.setCookie.length === 0) {
    throw new ProductError(response.status, "The reporting platform did not accept the sign-in");
  }
  const setCookie: string[] = body.setCookie.map(String);
  return {
    cookie: setCookie.map((header) => header.split(";")[0]).join("; "),
    setCookie,
    expiresAt: Number(body.expiresAt ?? Date.now() + 10 * 60 * 1000),
  };
}
