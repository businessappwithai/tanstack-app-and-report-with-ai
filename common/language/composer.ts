/**
 * EML Composer
 * ============
 * Writes a complete EML document — the inverse of the parsers.
 *
 * The generator's contract is that a model is one `.mmd` file: ERD, business
 * rules and workflows together, valid Mermaid throughout. Authoring surfaces
 * (the web app's design phase) hold those three concerns as separate records,
 * so something has to put them back into a single document before generation.
 * That is this file, and it is the only place that decides what a complete EML
 * document looks like.
 *
 * Two entry points:
 *
 *   composeEml(document)                 build a document from scratch
 *   mergeSections(source, { rules, workflows })
 *                                        replace the rules and workflow
 *                                        sections of an existing document,
 *                                        leaving its ERD and directives alone
 *
 * `mergeSections` is what an editor needs: the ERD is authored elsewhere (or by
 * an AI pass) and must survive round-trips through the rules editor untouched,
 * byte for byte.
 *
 * Everything here emits directives exactly as `appwithai-language.json`
 * declares them; see spec/05-directives.md.
 *
 * Deliberately dependency-free — the generator package re-exports it, so it has
 * to survive bundling without reaching for the language JSON on disk.
 */

/** The EML version stamped into a composed document's header. */
export const EML_VERSION = "1.0.0";

/* -------------------------------------------------------------------------- */
/*  Model                                                                      */
/* -------------------------------------------------------------------------- */

export interface EmlEnumDeclaration {
  name: string;
  values: string[];
}

export interface EmlCategoryDeclaration {
  name: string;
  description?: string;
  icon?: string;
  color?: string;
  seq?: number;
  isDefault?: boolean;
  entities?: string[];
}

/** A business-rules section: a decision flowchart bound to a lifecycle event. */
export interface EmlRuleSection {
  /** Directive name — slug-ish, unique within the document. */
  name: string;
  entity: string;
  /** Lifecycle event, e.g. beforeCreate. */
  event: string;
  priority?: number;
  /** Human-readable title for `%%meta name:`. Defaults to `name`. */
  title?: string;
  /** The flowchart body, starting at `flowchart`/`graph`. */
  flowchart: string;
}

/** A workflow section: hook flowchart, state diagram, or saga flowchart. */
export interface EmlWorkflowSection {
  name: string;
  entity: string;
  kind: "hook" | "state" | "saga";
  /**
   * Saga only. `rule` means the workflow runs only when a business rule emits a
   * trigger-workflow action naming it, so the rule's condition decides; the
   * default `automatic` runs it on every matching write.
   */
  trigger?: "automatic" | "rule";
  /** Saga only. Which write runs the workflow. Defaults to CREATE. */
  operation?: "CREATE" | "UPDATE" | "DELETE" | "ALL";
  /**
   * Hook and saga only. The state of the entity's status machine the workflow
   * is bound to: it runs in the second transaction of the button press that
   * moves the record into this state, and not on an ordinary save. Stored in
   * the lowercase underscore spelling the machine's events use.
   */
  status?: string;
  title?: string;
  /** The diagram body, starting at `flowchart`/`graph`/`stateDiagram-v2`. */
  diagram: string;
}

export interface EmlDocument {
  /** `%%meta name:` for the document. */
  name: string;
  version?: string;
  description?: string;
  enums?: EmlEnumDeclaration[];
  categories?: EmlCategoryDeclaration[];
  /** The ERD section, starting at `erDiagram`. */
  erd: string;
  rules?: EmlRuleSection[];
  workflows?: EmlWorkflowSection[];
}

/* -------------------------------------------------------------------------- */
/*  Emitters                                                                   */
/* -------------------------------------------------------------------------- */

const RULE_LEAD = "%%rule ";
const WORKFLOW_LEAD = "%%workflow ";

/** A banner comment. Plain `%%`, so renderers ignore it. */
function banner(title: string): string {
  const line = "=".repeat(74);
  return [`%% ${line}`, `%% ${title}`, `%% ${line}`].join("\n");
}

/** Trim trailing whitespace per line and collapse the trailing blank lines. */
function tidy(block: string): string {
  return block
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Ensure a diagram body opens with a diagram keyword.
 *
 * An editor that hands back only the node lines would otherwise produce a
 * document that no longer renders — the failure would surface as a parse error
 * at generation time, far from the edit that caused it.
 */
function ensureDiagram(body: string, fallbackKeyword: string): string {
  const trimmed = tidy(body);
  const opensDiagram = /^\s*(erDiagram|flowchart|graph|stateDiagram(-v2)?)\b/m.test(
    trimmed.split("\n").find((l) => l.trim() && !l.trim().startsWith("%%")) ?? ""
  );
  return opensDiagram ? trimmed : `${fallbackKeyword}\n${trimmed}`;
}

export function emitEnum(declaration: EmlEnumDeclaration): string {
  return `%%enum ${declaration.name}: ${declaration.values.join(", ")}`;
}

export function emitCategory(category: EmlCategoryDeclaration): string {
  const parts = [`name: ${category.name}`];
  if (category.description) parts.push(`description: ${category.description}`);
  if (category.icon) parts.push(`icon: ${category.icon}`);
  if (category.color) parts.push(`color: ${category.color}`);
  if (typeof category.seq === "number") parts.push(`seq: ${category.seq}`);
  if (category.isDefault) parts.push("default: true");
  if (category.entities?.length) parts.push(`entities: ${category.entities.join(", ")}`);
  return `%%category ${parts.join("; ")}`;
}

export function emitRuleSection(rule: EmlRuleSection): string {
  const directive =
    `${RULE_LEAD}${rule.name} on ${rule.entity} event: ${rule.event}` +
    (typeof rule.priority === "number" ? ` priority: ${rule.priority}` : "");

  return [
    `%%meta name: ${rule.title ?? rule.name}`,
    "%%meta kind: rules",
    directive,
    ensureDiagram(rule.flowchart, "flowchart TD"),
  ].join("\n");
}

export function emitWorkflowSection(workflow: EmlWorkflowSection): string {
  const keyword = workflow.kind === "state" ? "stateDiagram-v2" : "flowchart TD";
  // `trigger` only means anything for a saga, and only when it is not the
  // default — emitting `trigger: automatic` on every workflow would be noise in
  // every diff for a value that changes nothing.
  const trigger = workflow.kind === "saga" && workflow.trigger === "rule" ? " trigger: rule" : "";
  const operation =
    workflow.kind === "saga" && workflow.operation && workflow.operation !== "CREATE"
      ? ` operation: ${workflow.operation}`
      : "";
  const status =
    workflow.kind !== "state" && workflow.status ? ` status: ${workflow.status}` : "";
  return [
    `%%meta name: ${workflow.title ?? workflow.name}`,
    "%%meta kind: workflow",
    `${WORKFLOW_LEAD}${workflow.name} entity: ${workflow.entity} kind: ${workflow.kind}${trigger}${operation}${status}`,
    ensureDiagram(workflow.diagram, keyword),
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/*  Compose                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build a complete EML document.
 *
 * Section order is fixed — header, enums, categories, ERD, rules, workflows —
 * so two composes of the same model are byte-identical and a diff of the file
 * shows only what actually changed.
 */
export function composeEml(document: EmlDocument): string {
  const blocks: string[] = [];

  const header = [
    banner(document.name),
    `%%meta name: ${document.name}`,
    "%%meta kind: erd",
    `%%meta version: ${document.version ?? EML_VERSION}`,
  ];
  if (document.description) header.push(`%%meta description: ${document.description}`);
  blocks.push(header.join("\n"));

  if (document.enums?.length) {
    blocks.push(["%% ---- Enumerations ----", ...document.enums.map(emitEnum)].join("\n"));
  }

  if (document.categories?.length) {
    blocks.push(
      [
        "%% ---- Entity categories ----",
        "%% One dashboard block per category, ordered by name.",
        ...document.categories.map(emitCategory),
      ].join("\n")
    );
  }

  blocks.push(ensureDiagram(document.erd, "erDiagram"));

  if (document.rules?.length) {
    blocks.push(banner("Business rules"));
    for (const rule of document.rules) blocks.push(emitRuleSection(rule));
  }

  if (document.workflows?.length) {
    blocks.push(banner("Workflows"));
    for (const workflow of document.workflows) blocks.push(emitWorkflowSection(workflow));
  }

  return `${blocks.join("\n\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/*  Merge into an existing document                                            */
/* -------------------------------------------------------------------------- */

/**
 * Split a document at the first rules or workflow section.
 *
 * Everything before it — header directives, enums, categories, the ERD — is the
 * part an editor of rules or workflows must not touch. Returning it verbatim is
 * what makes a round-trip through the design UI non-destructive.
 */
export function splitAtSections(source: string): { preamble: string; sections: string } {
  const lines = source.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed.startsWith(RULE_LEAD) && !trimmed.startsWith(WORKFLOW_LEAD)) continue;

    // Walk back over the `%%meta` lines and the banner that introduce it, so a
    // re-compose does not leave the old section's header stranded.
    let start = i;
    while (start > 0) {
      const previous = lines[start - 1]!.trim();
      if (previous.startsWith("%%meta ") || previous.startsWith("%% =") || previous === "") {
        start -= 1;
        continue;
      }
      if (previous.startsWith("%% ") && lines[start - 2]?.trim().startsWith("%% =")) {
        start -= 1;
        continue;
      }
      break;
    }

    return {
      preamble: tidy(lines.slice(0, start).join("\n")),
      sections: tidy(lines.slice(start).join("\n")),
    };
  }

  return { preamble: tidy(source), sections: "" };
}

/**
 * Replace the rules and workflow sections of an existing document.
 *
 * The preamble — meta, enums, categories, ERD — is carried through untouched.
 * Passing an empty list removes those sections; passing `undefined` is not
 * meaningful here, since the caller owns the full set.
 */
export function mergeSections(
  source: string,
  sections: { rules?: EmlRuleSection[]; workflows?: EmlWorkflowSection[] }
): string {
  const { preamble } = splitAtSections(source);
  const blocks: string[] = [preamble];

  if (sections.rules?.length) {
    blocks.push(banner("Business rules"));
    for (const rule of sections.rules) blocks.push(emitRuleSection(rule));
  }

  if (sections.workflows?.length) {
    blocks.push(banner("Workflows"));
    for (const workflow of sections.workflows) blocks.push(emitWorkflowSection(workflow));
  }

  return `${blocks.filter(Boolean).join("\n\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/*  Read sections back out                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read the rule sections a document declares.
 *
 * Pairs with `emitRuleSection`, so an editor can load what it previously wrote.
 * The flowchart body runs from the directive to the next section directive or
 * the end of the document.
 */
export function extractRuleSections(source: string): EmlRuleSection[] {
  return extractSections(source, RULE_LEAD).map(({ directive, body, title }) => {
    const match = directive.match(
      /^(\S+)\s+on\s+(\S+)\s+event:\s*(\S+)(?:\s+priority:\s*(-?\d+))?/
    );
    return {
      name: match?.[1] ?? "rule",
      entity: match?.[2] ?? "",
      event: match?.[3] ?? "beforeCreate",
      priority: match?.[4] ? Number(match[4]) : undefined,
      title,
      flowchart: body,
    };
  });
}

/** Read the workflow sections a document declares. */
export function extractWorkflowSections(source: string): EmlWorkflowSection[] {
  return extractSections(source, WORKFLOW_LEAD).map(({ directive, body, title }) => {
    const match = directive.match(/^(\S+)\s+entity:\s*(\S+)\s+kind:\s*(\S+)/);
    const kind = match?.[3];
    const trigger = directive.match(/\btrigger:\s*(\S+)/)?.[1];
    const operation = directive.match(/\boperation:\s*(\S+)/)?.[1]?.toUpperCase();
    const status = directive.match(/\bstatus:\s*(\S+)/)?.[1];
    const resolvedKind = kind === "state" || kind === "saga" ? kind : "hook";
    return {
      name: match?.[1] ?? "workflow",
      entity: match?.[2] ?? "",
      kind: resolvedKind,
      trigger: trigger === "rule" ? "rule" : trigger === "automatic" ? "automatic" : undefined,
      operation:
        operation === "CREATE" ||
        operation === "UPDATE" ||
        operation === "DELETE" ||
        operation === "ALL"
          ? operation
          : undefined,
      status: status && resolvedKind !== "state" ? stateToken(status) : undefined,
      title,
      diagram: body,
    };
  });
}

/** `To Be Reviewed`, `to-be-reviewed` and `to_be_reviewed` name one state. */
export function stateToken(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

interface RawSection {
  directive: string;
  title?: string;
  body: string;
}

function extractSections(source: string, lead: string): RawSection[] {
  const lines = source.split("\n");
  const found: RawSection[] = [];

  let current: { directive: string; title?: string; body: string[] } | null = null;
  let pendingTitle: string | undefined;

  const close = () => {
    if (!current) return;
    const body = tidy(current.body.join("\n"));
    if (body) found.push({ directive: current.directive, title: current.title, body });
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // A banner rule separates sections; it is decoration, never part of a body.
    // Letting one through made extraction non-idempotent: the banner ended up
    // inside the preceding section's flowchart and was re-emitted alongside a
    // freshly generated one, so every save grew the document.
    if (/^%%\s*=+\s*$/.test(trimmed)) {
      close();
      continue;
    }

    // `%%meta name:` opens the *next* section's header, so it closes this one.
    const metaName = trimmed.match(/^%%meta\s+name:\s*(.+)$/);
    if (metaName) {
      close();
      pendingTitle = metaName[1]!.trim();
      continue;
    }

    // Other `%%meta` keys (kind, version) belong to a header, not to a body.
    if (trimmed.startsWith("%%meta ")) continue;

    if (trimmed.startsWith(lead)) {
      close();
      current = { directive: trimmed.slice(lead.length).trim(), title: pendingTitle, body: [] };
      pendingTitle = undefined;
      continue;
    }

    // A section directive of the other kind ends the one being collected.
    if (trimmed.startsWith(RULE_LEAD) || trimmed.startsWith(WORKFLOW_LEAD)) {
      close();
      pendingTitle = undefined;
      continue;
    }

    if (current) current.body.push(line);
  }

  close();
  return found;
}
