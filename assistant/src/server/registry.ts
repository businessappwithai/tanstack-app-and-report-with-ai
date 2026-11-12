/**
 * Intent → address. The only place an address is written.
 *
 * The model names what to open — a product, a kind, an object, an id — the way
 * a launchpad navigates by semantic object and action. This module turns that
 * into a path, after the product itself has confirmed the person may read the
 * target. The model never sees a path and cannot supply one: every part of the
 * result comes from a fixed table or from a value that passed a strict pattern.
 */
import type { AssistantConfig } from "./config";
import { type AppClient, isSafeId, isSafeName, ProductError, type ReportClient } from "./products";
import type { Intent } from "./tickets";

/** Reporting pages that are not about one definition. */
const REPORT_PAGES: Record<string, { path: string; title: string }> = {
  home: { path: "/dashboard", title: "Reporting home" },
  reports: { path: "/reports", title: "Reports" },
  charts: { path: "/charts", title: "Charts" },
  dashboards: { path: "/dashboards", title: "Dashboards" },
  queries: { path: "/queries", title: "Saved queries" },
  ask: { path: "/nl-query", title: "Ask a question about the data" },
};

export const reportPageKeys = (): string[] => Object.keys(REPORT_PAGES);

const REPORT_DEFINITION_PATH: Record<string, (id: string) => string> = {
  report: (id) => `/reports/${id}/viewer`,
  chart: (id) => `/charts/viewer/${id}`,
  dashboard: (id) => `/dashboards/${id}`,
};

export class NotAvailable extends Error {
  constructor() {
    // One wording for "does not exist" and "not yours": the caller learns nothing.
    super("That is not available to you.");
  }
}

export interface Clients {
  app: AppClient;
  /** Obtained on first use: a person who never opens a report never gets a reporting account. */
  report: () => Promise<ReportClient>;
}

const withEmbed = (path: string): string => `${path}${path.includes("?") ? "&" : "?"}embed=1`;

/** Resolve an intent to a path, or throw `NotAvailable`. Reads the target as the person first. */
export async function resolveIntent(
  config: AssistantConfig,
  clients: Clients,
  intent: Intent
): Promise<string> {
  try {
    if (intent.product === "app") {
      if (intent.kind === "record") {
        if (!isSafeName(intent.object) || !isSafeId(intent.id)) throw new NotAvailable();
        await clients.app.record(intent.object, intent.id);
        return withEmbed(`${config.appBasePath}/${intent.object}/${intent.id}`);
      }
      if (intent.kind === "page") {
        if (!isSafeName(intent.object)) throw new NotAvailable();
        const entities = await clients.app.entities();
        if (!entities.some((entity) => entity.table === intent.object)) throw new NotAvailable();
        return withEmbed(`${config.appBasePath}/${intent.object}`);
      }
      if (intent.kind === "admin") {
        const pages = await clients.app.adminPages();
        const page = pages.find((candidate) => candidate.route === intent.object);
        if (!page) throw new NotAvailable();
        return withEmbed(`${config.appBasePath}${page.route}`);
      }
      throw new NotAvailable();
    }

    if (intent.product === "report") {
      const report = await clients.report();
      if (intent.kind === "page") {
        const page = REPORT_PAGES[intent.object];
        if (!page) throw new NotAvailable();
        return withEmbed(`${config.reportBasePath}${page.path}`);
      }
      const build = REPORT_DEFINITION_PATH[intent.kind];
      if (!build || !isSafeId(intent.id)) throw new NotAvailable();
      await report.definition(intent.kind as "report" | "chart" | "dashboard", intent.id);
      return withEmbed(`${config.reportBasePath}${build(intent.id)}`);
    }
  } catch (error) {
    if (error instanceof NotAvailable) throw error;
    if (error instanceof ProductError && error.status < 500) throw new NotAvailable();
    throw error;
  }
  throw new NotAvailable();
}

export function reportPageTitle(key: string): string | null {
  return REPORT_PAGES[key]?.title ?? null;
}
