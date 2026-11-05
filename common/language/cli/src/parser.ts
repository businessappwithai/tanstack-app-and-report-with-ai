/**
 * EML parser.
 *
 * Parses a single .mmd EML document into the unified {@link EmlModel}. It reads
 * the ERD (`erDiagram`), business-rule and workflow flows (`flowchart`/`graph`),
 * state workflows (`stateDiagram-v2`), and every `%%` directive. Type and
 * cardinality vocabularies come from the canonical language definition
 * (`language/appwithai-language.json`) via the shared loader, so the parser
 * stays in lockstep with the language.
 */

import { cardinalityKind, isHookType, normalizeType } from "../../index";
import type {
  CanonicalType,
  Diagnostic,
  EmlAttribute,
  EmlEntity,
  EmlModel,
  EmlRule,
  EmlWorkflow,
  JdmNodeRole,
  ParsedCondition,
  RuleEdge,
  RuleNode,
  RuleNodeShape,
} from "./model";
import { emptyModel } from "./model";
import { caps, foreignKeyName, splitHead, stripQuotes, toSnakeCase } from "./util";

interface Section {
  type: "erd" | "flow" | "state";
  metaKind?: string; // from a preceding `%%meta kind:` directive
  metaName?: string;
  rule?: Partial<EmlRule>; // from a preceding `%%rule` directive
  workflow?: Partial<EmlWorkflow>; // from a preceding `%%workflow` directive
  startLine: number;
  lines: { text: string; n: number }[];
}

interface DirectiveResult {
  metaKind?: string;
  metaName?: string;
  rule?: Partial<EmlRule>;
  workflow?: Partial<EmlWorkflow>;
}

const SECTION_OPENERS = /^(erDiagram|flowchart|graph|stateDiagram-v2|stateDiagram)\b/;

export function parseEml(source: string): EmlModel {
  const model = emptyModel();
  fieldEnumRefs.length = 0;
  fieldHelp.length = 0;
  const diags = model.diagnostics;
  const normalized = source.replace(/\r\n/g, "\n");
  const rawLines = normalized.split("\n");

  // --- Pass 1: split into sections, harvest global directives & meta ---------
  const sections: Section[] = [];
  let current: Section | null = null;
  const pending: DirectiveResult = {};

  rawLines.forEach((raw, idx) => {
    const line = raw.trim();
    const n = idx + 1;
    if (!line) return;

    // Directives are processed both globally and (some) within their section.
    if (line.startsWith("%%")) {
      const dir = parseDirective(line, n, model);
      if (dir?.metaKind) pending.metaKind = dir.metaKind;
      if (dir?.metaName) pending.metaName = dir.metaName;
      if (dir?.rule) pending.rule = dir.rule;
      if (dir?.workflow) pending.workflow = dir.workflow;
      return;
    }

    const opener = line.match(SECTION_OPENERS);
    if (opener) {
      const [kw] = caps(opener, 1);
      const type: Section["type"] =
        kw === "erDiagram" ? "erd" : kw.startsWith("stateDiagram") ? "state" : "flow";
      current = {
        type,
        metaKind: pending.metaKind,
        metaName: pending.metaName,
        rule: pending.rule,
        workflow: pending.workflow,
        startLine: n,
        lines: [],
      };
      sections.push(current);
      pending.metaKind = undefined;
      pending.metaName = undefined;
      pending.rule = undefined;
      pending.workflow = undefined;
      return;
    }

    if (current) current.lines.push({ text: line, n });
  });

  // --- Pass 2: build the model from sections ---------------------------------
  for (const section of sections) {
    if (section.type === "erd") {
      parseErdSection(section, model, diags);
    } else if (section.type === "state") {
      parseStateSection(section, model);
    } else {
      parseFlowSection(section, model);
    }
  }

  // Attach enum references collected from %%field directives onto attributes.
  applyFieldEnumRefs(model);

  return model;
}

// ---------------------------------------------------------------------------
// Directives
// ---------------------------------------------------------------------------

interface FieldEnumRef {
  entity: string;
  attr: string;
  enumName: string;
}
const fieldEnumRefs: FieldEnumRef[] = [];

interface FieldHelp {
  entity: string;
  attr: string;
  text: string;
}
const fieldHelp: FieldHelp[] = [];

function parseDirective(line: string, n: number, model: EmlModel): DirectiveResult | undefined {
  const body = line.replace(/^%%/, "").trim();
  const { head: keyword, rest } = splitHead(body);

  switch (keyword) {
    case "meta": {
      const m = rest.match(/^([A-Za-z_][\w]*)\s*:\s*(.+)$/);
      if (!m) return;
      const [key, rawValue] = caps(m, 2);
      const value = rawValue.trim();
      if (key === "kind") return { metaKind: value };
      if (key === "name") {
        if (!model.meta.name) model.meta.name = value;
        return { metaName: value };
      }
      model.meta[key] = value;
      return;
    }
    case "hook": {
      const m = rest.match(/^(\w+)\s+(\w+)\s+on\s+(\w+)\s*(\[[^\]]*\])?/);
      if (!m) {
        // `%%hook <event> on <Entity>` — the two-token form, which names no
        // handler. It is an automation's trigger, not a handler binding, so it
        // deliberately does not join model.hooks: every consumer of that list
        // expects a handler to generate a module for. The checker validates it
        // from source instead (EML205/EML206).
        //
        // Reporting it as malformed here is what made every automation the
        // builder writes fail validation — `serializeAutomation()` emits this
        // line on every one of them.
        if (/^\w+\s+on\s+\w+\s*$/.test(rest)) return;
        model.diagnostics.push({
          severity: "error",
          code: "EML201",
          message: `Invalid %%hook syntax: "${line}"`,
          line: n,
        });
        return;
      }
      const [type, handler, entity, paramsRaw] = caps(m, 4);
      const fields = paramsRaw ? parseHookFields(paramsRaw) : [];
      if (!isHookType(type)) {
        model.diagnostics.push({
          severity: "error",
          code: "EML202",
          message: `Unknown hook type "${type}" in "${line}"`,
          line: n,
        });
        return;
      }
      model.hooks.push({ type, handler, entity, fields });
      return;
    }
    case "entity": {
      const m = rest.match(/^(\w+)\s+([A-Za-z_]\w*)\s*:\s*(.+)$/);
      if (m) {
        const [entity, key, value] = caps(m, 3);
        applyEntityMeta(model, entity, key, value.trim());
      }
      return;
    }
    case "field": {
      const m = rest.match(/^(\w+)\.(\w+)\s+([A-Za-z_]\w*)\s*:\s*(.+)$/);
      if (m) {
        const [entity, attr, key, value] = caps(m, 4);
        if (key === "enum") fieldEnumRefs.push({ entity, attr, enumName: value.trim() });
        // The column's own help text. Deferred like the enum bindings above,
        // because a %%field directive may be read before the ERD block that
        // declares the column it names.
        else if (key === "help" || key === "description")
          fieldHelp.push({ entity, attr, text: value.trim() });
      }
      return;
    }
    case "report": {
      // `sql:` takes the rest of the line, because SQL contains spaces and
      // colons and would otherwise be shredded by the key/value scan. Every
      // other key is read from the head, ahead of it.
      const split = rest.match(/^(.*?)\bsql:\s*(.+)$/s);
      if (!split) {
        model.diagnostics.push({
          severity: "error",
          code: "EML290",
          message: `%%report has no sql: clause: "${line}"`,
          line: n,
        });
        return;
      }
      const [head, sql] = caps(split, 2);
      const nameMatch = head.match(/^([A-Za-z_][\w-]*)\s*/);
      if (!nameMatch) {
        model.diagnostics.push({
          severity: "error",
          code: "EML291",
          message: `%%report has no name: "${line}"`,
          line: n,
        });
        return;
      }
      const [name] = caps(nameMatch, 1);
      const keys = head.slice(nameMatch[0].length);
      const read = (key: string): string | undefined => {
        const m2 = keys.match(
          new RegExp(`\\b${key}:\\s*(.*?)(?=\\s+(?:title|entity|chart|x|y|help):|$)`, "s")
        );
        return m2?.[1]?.trim() || undefined;
      };
      const chartRaw = read("chart");
      const chart =
        chartRaw === "bar" || chartRaw === "line" || chartRaw === "pie" || chartRaw === "area"
          ? chartRaw
          : undefined;
      if (chartRaw && !chart) {
        model.diagnostics.push({
          severity: "error",
          code: "EML296",
          message: `%%report "${name}" has unknown chart type "${chartRaw}".`,
          line: n,
        });
      }
      model.reports.push({
        name,
        title: read("title") ?? name.replace(/[_-]+/g, " "),
        entity: read("entity"),
        chart,
        x: read("x"),
        y: read("y"),
        help: read("help"),
        sql: sql.trim(),
      });
      return;
    }
    case "dashboard": {
      // `%%dashboard <name> title: <T> role: <role> reports: <a>, <b>, … [help: <why>]`.
      // `reports:` is a comma list, so it is read up to the next key like any
      // other value; there is no sql: clause to split off first.
      const nameMatch = rest.match(/^([A-Za-z_][\w-]*)\s*/);
      if (!nameMatch) {
        model.diagnostics.push({
          severity: "error",
          code: "EML297",
          message: `%%dashboard has no name: "${line}"`,
          line: n,
        });
        return;
      }
      const [name] = caps(nameMatch, 1);
      const keys = rest.slice(nameMatch[0].length);
      // Split at the keys once: a lazy lookahead per key backtracks over every value.
      const marks = [...keys.matchAll(/(?:^|\s)(title|role|reports|help):/g)];
      const values: Record<string, string> = {};
      marks.forEach((mark, i) => {
        const key = mark[1] as string;
        if (key in values) return;
        const from = (mark.index ?? 0) + mark[0].length;
        const value = keys.slice(from, marks[i + 1]?.index ?? keys.length).trim();
        if (value) values[key] = value;
      });
      const read = (key: string): string | undefined => values[key];
      model.dashboards.push({
        name,
        title: read("title") ?? name.replace(/[_-]+/g, " "),
        role: read("role"),
        reports: (read("reports") ?? "")
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean),
        help: read("help"),
      });
      return;
    }
    case "enum": {
      const m = rest.match(/^(\w+)\s*:\s*(.+)$/);
      if (m) {
        const [name, rawValues] = caps(m, 2);
        const values = rawValues
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
        if (!model.enums.some((e) => e.name === name)) model.enums.push({ name, values });
      }
      return;
    }
    case "index": {
      const m = rest.match(/^(\w+)\s*\(([^)]*)\)\s*(unique)?/i);
      if (m) {
        const [entity, rawColumns, uniqueFlag] = caps(m, 3);
        const columns = rawColumns
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        model.indexes.push({ entity, columns, unique: !!uniqueFlag });
      }
      return;
    }
    case "rule": {
      // Attach to the *next* flow section.
      const m = rest.match(/^(\w+)\s+on\s+(\w+)(?:\s+event:\s*(\w+))?(?:\s+priority:\s*(\d+))?/);
      if (m) {
        const [name, entity, event, priority] = caps(m, 4);
        return {
          rule: {
            name,
            entity,
            event: event || undefined,
            priority: priority ? Number(priority) : undefined,
          },
        };
      }
      return;
    }
    case "workflow": {
      const m = rest.match(/^(\w+)\s+entity:\s*(\w+)\s+kind:\s*(\w+)/);
      if (m) {
        const [name, entity, kind] = caps(m, 3);
        return {
          workflow: {
            name,
            entity,
            kind: (kind as EmlWorkflow["kind"]) || "hook",
          },
        };
      }
      return;
    }
    case "guard": {
      const m = rest.match(/^(\S+)\s+on\s+(\w+)\.(\w+)/);
      if (m) {
        const [roleExpr, entity, op] = caps(m, 3);
        const roles = roleExpr
          .split("|")
          .map((r) => r.replace(/^role:/, "").trim())
          .filter(Boolean);
        model.guards.push({ roles, entity, op });
      }
      return;
    }
    case "trigger": {
      // Source may contain spaces (e.g. a cron expression), so match up to "->".
      const m = rest.match(/^(.+?)\s*->\s*(\w+)\s+on\s+(\w+)/);
      if (m) {
        const [source, handler, entity] = caps(m, 3);
        model.triggers.push({ source: source.trim(), handler, entity });
      }
      return;
    }
    default:
      // Plain comment — ignored.
      return;
  }
}

function parseHookFields(paramsRaw: string): string[] {
  const inner = paramsRaw.slice(1, -1);
  return inner
    .split(",")
    .map((p) => p.trim().replace(/^field:\s*/, ""))
    .filter(Boolean);
}

function applyEntityMeta(model: EmlModel, name: string, key: string, value: string): void {
  const ensure = (): EmlEntity => {
    let e = model.entities.find((x) => x.name === name);
    if (!e) {
      // Entity metadata may appear before/after the block; stash a placeholder.
      e = {
        name,
        tableName: toSnakeCase(name),
        attributes: [],
        primaryKey: "id",
        timestamps: true,
      };
      model.entities.push(e);
    }
    return e;
  };
  const e = ensure();
  if (key === "audited") e.audited = value === "true";
  else if (key === "softDelete") e.softDelete = value === "true";
  else if (key === "prefix") e.prefix = value;
  else if (key === "label") e.label = value;
  // `help:` and `description:` are the same key under two spellings, and both
  // are compiled rather than decorative — see EmlEntity.help.
  else if (key === "help" || key === "description") e.help = value;
}

// ---------------------------------------------------------------------------
// ERD section
// ---------------------------------------------------------------------------

function parseErdSection(section: Section, model: EmlModel, diags: Diagnostic[]): void {
  let currentEntity: EmlEntity | null = null;
  let attrs: EmlAttribute[] = [];

  const flush = () => {
    if (currentEntity) {
      mergeEntity(model, currentEntity, attrs);
      currentEntity = null;
      attrs = [];
    }
  };

  for (const { text, n } of section.lines) {
    const rel = parseRelationship(text);
    if (rel) {
      model.relationships.push(rel);
      continue;
    }

    const start = text.match(/^([A-Za-z][\w]*)\s*\{$/);
    if (start) {
      flush();
      const [entityName] = caps(start, 1);
      currentEntity = {
        name: entityName,
        tableName: toSnakeCase(entityName),
        attributes: [],
        primaryKey: "id",
        timestamps: true,
      };
      continue;
    }

    if (text === "}") {
      flush();
      continue;
    }

    if (currentEntity) {
      const attr = parseAttribute(text);
      if (attr) attrs.push(attr);
      else
        diags.push({
          severity: "warning",
          code: "EML110",
          message: `Could not parse attribute: "${text}"`,
          line: n,
        });
    }
  }
  flush();
}

function mergeEntity(model: EmlModel, entity: EmlEntity, attrs: EmlAttribute[]): void {
  // A placeholder created by %%entity metadata may already exist; merge into it.
  const existing = model.entities.find((e) => e.name === entity.name);
  const target = existing ?? entity;
  if (existing) {
    existing.tableName = toSnakeCase(entity.name);
    existing.timestamps = entity.timestamps;
  } else {
    model.entities.push(entity);
  }
  target.attributes = attrs;

  // Auto-add id if no id/*_id present (mirrors the shipped generator behaviour).
  const hasId = attrs.some((a) => a.name === "id" || a.name.endsWith("_id"));
  if (!hasId) {
    attrs.unshift({
      name: "id",
      type: "string",
      rawType: "string",
      required: true,
      unique: true,
      isPrimaryKey: true,
      isForeignKey: false,
    });
  }
  const pk = attrs.find((a) => a.isPrimaryKey) ?? attrs.find((a) => a.name === "id");
  target.primaryKey = pk?.name ?? "id";
}

function parseAttribute(line: string): EmlAttribute | null {
  // <type>[(len)] <name> [modifiers...] ["description"]
  const descMatch = line.match(/"([^"]*)"\s*$/);
  const description = descMatch ? caps(descMatch, 1)[0] : undefined;
  const withoutDesc = descMatch ? line.slice(0, descMatch.index).trim() : line;

  const parts = withoutDesc.split(/\s+/);
  if (parts.length < 2) return null;

  const rawTypeToken = parts[0] ?? "";
  const name = parts[1] ?? "";
  if (!/^[A-Za-z][\w]*$/.test(name)) return null;

  const lengthMatch = rawTypeToken.match(/\((\d+)\)/);
  const maxLength = lengthMatch ? Number(caps(lengthMatch, 1)[0]) : undefined;
  const rawType = rawTypeToken.replace(/\(\d+\)/, "");
  const type = normalizeType(rawType) as CanonicalType;

  const modifiers = parts.slice(2).map((m) => m.toUpperCase());
  const isPrimaryKey = modifiers.includes("PK");
  const isForeignKey = modifiers.includes("FK");
  const isUnique = modifiers.includes("UK") || modifiers.includes("UNIQUE");
  const isOptional = modifiers.includes("OPTIONAL") || modifiers.includes("NULL");

  return {
    name,
    type,
    rawType,
    maxLength,
    required: !isOptional && !isPrimaryKey,
    unique: isUnique || isPrimaryKey,
    isPrimaryKey,
    isForeignKey,
    description,
  };
}

function parseRelationship(line: string): EmlModel["relationships"][number] | null {
  // Left <op> Right : "label"   (label optional)
  // Operator glyphs: left ∈ {||,}o,}|,|o}; right ∈ {||,o{,|{,o|}; link -- or ..
  const m = line.match(
    /^([A-Za-z_]\w*)\s+([|}][|o](?:--|\.\.)[|o][|{])\s+([A-Za-z_]\w*)\s*(?::\s*(.+))?$/
  );
  if (!m) return null;
  const [source, opRaw, target, labelRaw] = caps(m, 4);
  const op = opRaw.replace("..", "--"); // normalize non-identifying link for lookup
  const kind = cardinalityKind(op);
  if (!kind) return null;
  const label = labelRaw
    ? stripQuotes(labelRaw)
    : `${source.toLowerCase()}_${target.toLowerCase()}`;
  return {
    name: label.replace(/\s+/g, "_").toLowerCase(),
    source,
    target,
    cardinality: kind,
    operator: op,
    foreignKey: foreignKeyName(target),
  };
}

// ---------------------------------------------------------------------------
// Flow sections (business rules or hook workflows)
// ---------------------------------------------------------------------------

function parseFlowSection(section: Section, model: EmlModel): void {
  const { nodes, edges } = parseFlowGraph(section.lines.map((l) => l.text));

  const rule = section.rule;
  const workflow = section.workflow;
  const isRules =
    section.metaKind === "rules" || (!!rule && section.metaKind !== "workflow" && !workflow);

  if (isRules) {
    model.rules.push({
      name: rule?.name ?? section.metaName ?? `rule_${model.rules.length + 1}`,
      entity: rule?.entity,
      event: rule?.event,
      priority: rule?.priority,
      nodes,
      edges,
      raw: `flowchart TD\n${section.lines.map((l) => `    ${l.text}`).join("\n")}\n`,
    });
    return;
  }

  // Workflow (hook form): hooks were harvested globally; associate those that
  // belong to this workflow's entity.
  const wf: EmlWorkflow = {
    name: workflow?.name ?? section.metaName ?? `workflow_${model.workflows.length + 1}`,
    entity: workflow?.entity,
    kind: workflow?.kind ?? "hook",
    hooks: workflow?.entity ? model.hooks.filter((h) => h.entity === workflow.entity) : [],
    states: [],
    transitions: [],
    guards: workflow?.entity ? model.guards.filter((g) => g.entity === workflow.entity) : [],
    triggers: workflow?.entity ? model.triggers.filter((t) => t.entity === workflow.entity) : [],
  };
  model.workflows.push(wf);
}

function parseFlowGraph(lines: string[]): { nodes: RuleNode[]; edges: RuleEdge[] } {
  const nodesById = new Map<string, RuleNode>();
  const edges: RuleEdge[] = [];
  const nodeToken =
    "([A-Za-z_]\\w*)(\\(\\[[^\\]]*\\]\\)|\\(\\([^)]*\\)\\)|\\{[^}]*\\}|\\[[^\\]]*\\]|\\([^)]*\\))?";
  const edgeRe = new RegExp(
    `^${nodeToken}\\s*(?:-->|---|-\\.->|==>)\\s*(?:\\|([^|]*)\\|)?\\s*${nodeToken}`
  );

  const ensureNode = (id: string, suffix?: string) => {
    const existing = nodesById.get(id);
    if (existing) {
      if (suffix && existing.label === id) {
        const parsed = parseNode(id, suffix);
        if (parsed) nodesById.set(id, parsed);
      }
      return;
    }
    nodesById.set(id, suffix ? (parseNode(id, suffix) ?? bareNode(id)) : bareNode(id));
  };

  for (const line of lines) {
    const em = line.match(edgeRe);
    if (em) {
      const [srcId, srcSuffix, edgeLabel, tgtId, tgtSuffix] = caps(em, 5);
      ensureNode(srcId, srcSuffix);
      ensureNode(tgtId, tgtSuffix);
      edges.push({ source: srcId, target: tgtId, label: edgeLabel?.trim() || undefined });
      continue;
    }
    const nm = line.match(new RegExp(`^${nodeToken}\\s*$`));
    if (nm?.[1] && nm[2]) ensureNode(nm[1], nm[2]);
  }

  // Resolve stadium input vs output by connectivity, and parse decision conditions.
  const sources = new Set(edges.map((e) => e.source));
  const targets = new Set(edges.map((e) => e.target));
  for (const node of nodesById.values()) {
    node.jdmType = resolveJdmType(node.shape, sources.has(node.id), targets.has(node.id));
    if (node.shape === "diamond") node.condition = parseCondition(node.label);
  }

  return { nodes: [...nodesById.values()], edges };
}

function bareNode(id: string): RuleNode {
  return { id, label: id, shape: "rect", jdmType: "expressionNode" };
}

function parseNode(id: string, suffix: string): RuleNode | null {
  const shapes: Array<{ re: RegExp; shape: RuleNodeShape; jdmType: JdmNodeRole }> = [
    { re: /^\(\[(.+?)\]\)$/, shape: "stadium", jdmType: "inputNode" },
    { re: /^\(\((.+?)\)\)$/, shape: "circle", jdmType: "functionNode" },
    { re: /^\{(.+?)\}$/, shape: "diamond", jdmType: "switchNode" },
    { re: /^\[(.+?)\]$/, shape: "rect", jdmType: "expressionNode" },
    { re: /^\((.+?)\)$/, shape: "rounded", jdmType: "functionNode" },
  ];
  for (const { re, shape, jdmType } of shapes) {
    const m = suffix.match(re);
    if (m) return { id, label: caps(m, 1)[0].trim(), shape, jdmType };
  }
  return null;
}

function resolveJdmType(shape: RuleNodeShape, isSource: boolean, isTarget: boolean): JdmNodeRole {
  if (shape === "stadium") return isTarget && !isSource ? "outputNode" : "inputNode";
  if (shape === "diamond") return "switchNode";
  if (shape === "circle" || shape === "rounded") return "functionNode";
  return "expressionNode";
}

/**
 * Best-effort machine-readable condition from a decision-node label, e.g.
 * "Order Amount > 1000" -> { field: order_amount, op: ">", value: 1000 }.
 * Returns undefined when the label is not a simple comparison.
 */
function parseCondition(label: string): ParsedCondition | undefined {
  const cleaned = label.replace(/\?$/, "").trim();
  const cmp = cleaned.match(/^(.+?)\s*(>=|<=|==|!=|>|<)\s*(.+)$/);
  if (cmp) {
    const [cmpField, cmpOp, cmpValue] = caps(cmp, 3);
    const rawVal = stripQuotes(cmpValue).replace(/[$,]/g, "");
    const num = Number(rawVal);
    const value: string | number | boolean = Number.isNaN(num)
      ? rawVal === "true"
        ? true
        : rawVal === "false"
          ? false
          : rawVal
      : num;
    return {
      field: fieldSlug(cmpField),
      op: cmpOp as ParsedCondition["op"],
      value,
      raw: cleaned,
    };
  }
  const contains = cleaned.match(/^(.+?)\s+contains\s+(.+)$/i);
  if (contains) {
    const [containsField, containsValue] = caps(contains, 2);
    return {
      field: fieldSlug(containsField),
      op: "contains",
      value: stripQuotes(containsValue),
      raw: cleaned,
    };
  }
  return undefined;
}

function fieldSlug(text: string): string {
  return toSnakeCase(
    text
      .replace(/[^A-Za-z0-9_ ]/g, "")
      .trim()
      .replace(/\s+/g, "_")
  );
}

// ---------------------------------------------------------------------------
// State sections (state workflows)
// ---------------------------------------------------------------------------

function parseStateSection(section: Section, model: EmlModel): void {
  const states = new Set<string>();
  const transitions: EmlWorkflow["transitions"] = [];

  for (const { text } of section.lines) {
    const m = text.match(/^(\[\*\]|\w+)\s*-->\s*(\[\*\]|\w+)\s*(?::\s*(.+))?$/);
    if (!m) continue;
    const [from, to, rawEvent] = caps(m, 3);
    const event = rawEvent.trim() || undefined;
    if (from !== "[*]") states.add(from);
    if (to !== "[*]") states.add(to);
    transitions.push({ from, to, event });
  }

  const wf = section.workflow;
  const entity = wf?.entity;
  model.workflows.push({
    name: wf?.name ?? section.metaName ?? `workflow_${model.workflows.length + 1}`,
    entity,
    kind: "state",
    hooks: entity ? model.hooks.filter((h) => h.entity === entity) : [],
    states: [...states],
    transitions,
    guards: entity ? model.guards.filter((g) => g.entity === entity) : [],
    triggers: entity ? model.triggers.filter((t) => t.entity === entity) : [],
  });
}

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

function applyFieldEnumRefs(model: EmlModel): void {
  for (const ref of fieldEnumRefs) {
    const entity = model.entities.find((e) => e.name === ref.entity);
    const attr = entity?.attributes.find((a) => a.name === ref.attr);
    if (attr) attr.enumRef = ref.enumName;
  }
  fieldEnumRefs.length = 0;

  // `%%field <E>.<c> help:` wins over an inline "description" on the ERD line:
  // the directive is the later, more deliberate statement of the two, and a
  // model carrying both means the author wrote the directive to replace it.
  for (const h of fieldHelp) {
    const entity = model.entities.find((e) => e.name === h.entity);
    const attr = entity?.attributes.find((a) => a.name === h.attr);
    if (attr) attr.description = h.text;
  }
  fieldHelp.length = 0;
}
