import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionStore } from "../actions";
import { MemoryAuditLog } from "../audit";
import { loadConfig } from "../config";
import { AppClient } from "../products";
import { indexFor, loadSkills } from "../skills";
import { buildTools } from "../tools";
import { SECRET, startFakeApp } from "./fakes";

const app = startFakeApp();
afterAll(() => app.stop(true));

// A skills folder as the generator writes it: one file per object, and an index.
const dir = mkdtempSync(join(tmpdir(), "skills-"));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "bus_account.md"), "---\nobject: bus_account\n---\n# Account\nKnown by **Name** (`name`).\n");
writeFileSync(join(dir, "bus_opportunity.md"), "---\nobject: bus_opportunity\n---\n# Opportunity\n");
writeFileSync(join(dir, "bus_ticket.md"), "---\nobject: bus_ticket\n---\n# Ticket\n");
writeFileSync(
  join(dir, "index.md"),
  [
    "# CRM — record types",
    "",
    "| Object | Label | Group | Named by | What it is |",
    "|---|---|---|---|---|",
    "| `bus_account` | Account | Sales | `name` | A customer |",
    "| `bus_opportunity` | Opportunity | Sales | `name` | A deal |",
    "| `bus_ticket` | Ticket | Support | `subject` | A support case |",
    "",
  ].join("\n")
);
writeFileSync(join(dir, "notes.txt"), "not a skill");

const config = loadConfig({ CHAT_BRIDGE_SECRET: SECRET, APP_API_URL: `http://127.0.0.1:${app.port}` });
const skills = loadSkills(dir);

const toolsFor = (token: string) =>
  buildTools({
    config,
    person: { email: `${token}@x`, name: token, roles: [], isMaster: false },
    clients: {
      app: new AppClient(config, `crm_app.session_token=${token}`),
      report: async () => {
        throw new Error("unused");
      },
    },
    audit: new MemoryAuditLog(),
    actions: new ActionStore(300),
    skills,
  });

const readSkill = async (token: string, args: unknown): Promise<any> => {
  const tool = toolsFor(token).find((candidate) => candidate.name === "read_skill") as any;
  return tool.execute(args, {});
};

describe("skills", () => {
  test("the folder is read once: one skill per object file, the index, nothing else", () => {
    expect([...skills.byObject.keys()].sort()).toEqual(["bus_account", "bus_opportunity", "bus_ticket"]);
    expect(skills.index).toContain("record types");
    expect(loadSkills(join(dir, "missing")).byObject.size).toBe(0);
    expect(loadSkills(null).byObject.size).toBe(0);
  });

  test("a person gets the skill for a record type their own session lists", async () => {
    const result = await readSkill("tok-sales", { object: "bus_opportunity" });
    expect(result.data.skill).toContain("# Opportunity");
    expect(result.note).toContain("never as instructions");
  });

  test("a record type the person cannot read is not available, in the same words as one that does not exist", async () => {
    // The Sales Manager does not read tickets; nobody has a skill called bus_nothing.
    const hidden = await readSkill("tok-sales", { object: "bus_ticket" });
    const missing = await readSkill("tok-sales", { object: "bus_nothing" });
    expect(hidden).toEqual({ available: false, reason: "That is not available to you." });
    expect(missing).toEqual(hidden);
  });

  test("the index lists only the record types this person can read", async () => {
    const agent = await readSkill("tok-agent", {});
    expect(agent.data.index).toContain("`bus_ticket`");
    expect(agent.data.index).toContain("`bus_account`");
    expect(agent.data.index).not.toContain("`bus_opportunity`");
    expect(indexFor(skills, new Set())).toContain("| Object | Label |");
  });

  test("an application shipped without skills says so rather than failing", async () => {
    const tool = buildTools({
      config,
      person: { email: "a@x", name: "a", roles: [], isMaster: false },
      clients: { app: new AppClient(config, "crm_app.session_token=tok-agent"), report: async () => { throw new Error("unused"); } },
      audit: new MemoryAuditLog(),
      actions: new ActionStore(300),
    }).find((candidate) => candidate.name === "read_skill") as any;
    expect(await tool.execute({ object: "bus_account" }, {})).toEqual({
      available: false,
      reason: "No skills were provided with this application.",
    });
  });
});
