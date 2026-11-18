/**
 * The generated application's skills: Markdown that tells the model how one
 * record type is named, what its form holds, which buttons move it and which
 * reports are about it.
 *
 * The generator writes them (`assistant-skills/` in the generated project, from
 * the same derivations as its manual) and the compose file mounts that folder
 * read-only at `CHAT_SKILLS_DIR`. They are read once, at start-up.
 *
 * **A skill is context, not access.** The tool that hands one out checks first
 * that the person's own application session lists the record type, so a skill
 * never tells somebody about an entity the application would not show them; and
 * everything the model then does still runs as that person.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OBJECT = /^[a-z][a-z0-9_]{0,62}$/;

export interface Skills {
  /** One skill per object key (the entity's table, e.g. `bus_shipment`). */
  byObject: Map<string, string>;
  /** The generated index, one table row per object. */
  index: string;
}

export const NO_SKILLS: Skills = { byObject: new Map(), index: "" };

/** Read every `<object>.md` and `index.md` in the folder. A missing folder is no skills, not an error. */
export function loadSkills(directory: string | null): Skills {
  if (!directory || !existsSync(directory)) return NO_SKILLS;
  const byObject = new Map<string, string>();
  let index = "";
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".md")) continue;
    const content = readFileSync(join(directory, name), "utf-8");
    if (name === "index.md") index = content;
    else {
      const object = name.slice(0, -3);
      if (OBJECT.test(object)) byObject.set(object, content);
    }
  }
  return { byObject, index };
}

/**
 * The index cut down to the record types this person can read: the header, and
 * each row whose object they hold. A row is `| \`object\` | …`.
 */
export function indexFor(skills: Skills, readable: Set<string>): string {
  const lines = skills.index.split("\n");
  return lines
    .filter((line) => {
      const object = /^\|\s*`([a-z0-9_]+)`\s*\|/.exec(line)?.[1];
      return object === undefined || readable.has(object);
    })
    .join("\n");
}
