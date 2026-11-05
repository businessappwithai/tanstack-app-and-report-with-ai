/**
 * EML unified model.
 *
 * The single in-memory representation of an .mmd EML document after parsing:
 * the data model (entities/relationships/enums/indexes), the declarative
 * business rules (decision flows), and the business workflows (lifecycle hooks
 * and state machines). The generator consumes this model to emit an application.
 */

export type CanonicalType =
  | "string"
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "datetime"
  | "json";

export type CardinalityKind = "oneToOne" | "oneToMany" | "manyToOne" | "manyToMany";

export type HookType =
  | "beforeCreate"
  | "afterCreate"
  | "beforeUpdate"
  | "afterUpdate"
  | "beforeDelete"
  | "afterDelete"
  | "beforeQuery"
  | "afterQuery"
  | "customValidate"
  | "beforeRead"
  | "afterRead"
  | "beforeList"
  | "afterList";

export type RuleNodeShape = "stadium" | "diamond" | "circle" | "rounded" | "rect";
export type JdmNodeRole =
  | "inputNode"
  | "outputNode"
  | "switchNode"
  | "functionNode"
  | "expressionNode";

export interface EmlAttribute {
  name: string;
  type: CanonicalType;
  rawType: string;
  maxLength?: number;
  required: boolean;
  unique: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  enumRef?: string;
  description?: string;
}

export interface EmlEntity {
  name: string;
  tableName: string;
  attributes: EmlAttribute[];
  primaryKey: string;
  timestamps: boolean;
  audited?: boolean;
  softDelete?: boolean;
  prefix?: string;
  label?: string;
  /**
   * `%%entity <Name> help:` — what this entity is for, in the author's words.
   *
   * The only place a model carries the *reason* an entity exists rather than
   * its shape, which is why it is the text every downstream description is
   * built from: the generated manual's prose, and the reporting pack's report
   * and chart descriptions. A model that leaves it out produces reports named
   * after tables; one that fills it in produces reports named after the
   * business.
   */
  help?: string;
}

export interface EmlRelationship {
  name: string;
  source: string;
  target: string;
  cardinality: CardinalityKind;
  operator: string;
  foreignKey: string;
}

export interface EmlEnum {
  name: string;
  values: string[];
}

export interface EmlIndex {
  entity: string;
  columns: string[];
  unique: boolean;
}

export interface RuleNode {
  id: string;
  label: string;
  shape: RuleNodeShape;
  jdmType: JdmNodeRole;
  /** Parsed condition when the label is machine-evaluable (decision nodes). */
  condition?: ParsedCondition;
}

export interface RuleEdge {
  source: string;
  target: string;
  label?: string;
}

export interface ParsedCondition {
  field: string;
  op: ">" | ">=" | "<" | "<=" | "==" | "!=" | "contains";
  value: string | number | boolean;
  raw: string;
}

export interface EmlRule {
  name: string;
  entity?: string;
  event?: string;
  priority?: number;
  nodes: RuleNode[];
  edges: RuleEdge[];
  /** The original Mermaid flowchart source for this rule (fed to the JDM converter). */
  raw?: string;
}

export interface EmlHook {
  type: HookType;
  handler: string;
  entity: string;
  fields: string[];
}

export interface EmlTransition {
  from: string;
  to: string;
  event?: string;
}

export interface EmlGuard {
  roles: string[];
  entity: string;
  op: string;
}

export interface EmlTrigger {
  source: string;
  handler: string;
  entity: string;
}

export interface EmlWorkflow {
  name: string;
  entity?: string;
  kind: "hook" | "state" | "saga";
  hooks: EmlHook[];
  states: string[];
  transitions: EmlTransition[];
  guards: EmlGuard[];
  triggers: EmlTrigger[];
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  line?: number;
  /** Human description of the auto-correction applied, if any. */
  fix?: string;
}

export interface EmlMeta {
  name?: string;
  version?: string;
  stack?: string;
  [key: string]: string | undefined;
}

/**
 * `%%report` — a question the application's users actually ask, written into
 * the model beside the entities it is asked about.
 *
 * The reporting pack derives a baseline from structure alone: a register per
 * entity, a breakdown per enum, a lifecycle per state machine. That baseline
 * describes the *shape* of the data and nothing about the business running on
 * it. Nothing in an ERD says that a sales manager opens the application to see
 * which deals slipped this quarter, or that a dispatcher needs the jobs with no
 * engineer assigned — those come from knowing the domain, and this directive is
 * where that knowledge is written down.
 *
 * `sql` is deliberately the author's own, and deliberately last on the line: it
 * runs against the generated application's database as written.
 */
export interface EmlReport {
  /** Stable identifier, used as the pack key. */
  name: string;
  /** What the report is called on screen. */
  title: string;
  /** The entity it is mainly about, when it is about one. Used for grouping. */
  entity?: string;
  /** Absent means a table; present means a chart of this type as well. */
  chart?: "bar" | "line" | "pie" | "area";
  /** Result columns the chart plots. Required when `chart` is set. */
  x?: string;
  y?: string;
  /** Who asks this question and why — shown as the report's description. */
  help?: string;
  /** The query, exactly as it will be run. */
  sql: string;
}

/**
 * `%%dashboard` — a named collection of a role's own reports, written into the
 * model beside the reports it shows.
 *
 * The reporting pack derives one overview dashboard from structure. That cannot
 * say which questions belong together for the person who asks them: a sales
 * manager's weekly pipeline review, a dispatcher's morning board. This directive
 * is where an author groups a role's `%%report` directives into a dashboard,
 * and `role:` is what makes it that role's.
 */
export interface EmlDashboard {
  /** Stable identifier, used as the pack key. */
  name: string;
  /** What the dashboard is called on screen. */
  title: string;
  /** The declared `%%rbac` role this dashboard is for. */
  role?: string;
  /** The `%%report` names it shows, in order. */
  reports: string[];
  /** Who opens this dashboard and what they decide from it. */
  help?: string;
}

export interface EmlModel {
  meta: EmlMeta;
  entities: EmlEntity[];
  relationships: EmlRelationship[];
  enums: EmlEnum[];
  indexes: EmlIndex[];
  rules: EmlRule[];
  reports: EmlReport[];
  dashboards: EmlDashboard[];
  workflows: EmlWorkflow[];
  hooks: EmlHook[];
  guards: EmlGuard[];
  triggers: EmlTrigger[];
  diagnostics: Diagnostic[];
}

export function emptyModel(): EmlModel {
  return {
    meta: {},
    entities: [],
    relationships: [],
    enums: [],
    indexes: [],
    rules: [],
    reports: [],
    dashboards: [],
    workflows: [],
    hooks: [],
    guards: [],
    triggers: [],
    diagnostics: [],
  };
}
