/*
 * Copyright 2021-Present The Open Workflow Specification Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * oUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { canonicalPointerAt, resolveSchemaAt, schemaBranchesAt, schemaFieldsAt, typeNameAt } from './schema-resolution';
import { validationPointers } from './generated/validation';
import { workflowSchema } from './schema';

/**
 * What a type can contain, asked by name.
 *
 * The question this answers is *"pass a task type, get all its fields"* — with references followed
 * and inherited fields merged, so a caller never has to know that `timeout` reaches `SetTask`
 * through an `allOf` on `taskBase`, or that `with.endpoint` is a `$ref` whose own description
 * overrides its target's.
 *
 */


const positions = ((): ReadonlyMap<string, string> => {
  const index = new Map<string, string>();

  const walk = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${pointer}/${i}`));
    } else if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.title === 'string' && !index.has(record.title)) index.set(record.title, pointer);
      for (const [key, value] of Object.entries(record)) {
        walk(value, `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
      }
    }
  };
  walk(workflowSchema, '#');

  for (const [name, url] of Object.entries(validationPointers as Record<string, string>)) {
    index.set(name, url.slice(url.indexOf('#')));
  }

  return index;
})();

const pointerOf = (typeName: string): string | undefined => positions.get(typeName);

/**
 * The validation keywords the DSL schema uses, copied verbatim.
 *
 * All of them rather than a chosen few: a form needs them for input hints and client-side checks,
 * and picking a subset means somebody hits the missing one later. The schema's keyword-coverage
 * test fails by name if a new one ever appears.
 */
const TEXT_CONSTRAINTS = [
  'pattern',
  'format',
] as const;

const NUMBER_CONSTRAINTS = [  
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
] as const

const CONSTRAINT_KEYWORDS = [...TEXT_CONSTRAINTS, ...NUMBER_CONSTRAINTS] as const;

export interface TypeConstraints {
pattern?: string;
format?: string;
minLength?: number;
maxLength?: number;
minimum?: number;
maximum?: number;
minItems?: number;
maxItems?: number;
minProperties?: number;
maxProperties?: number;
}

/** Every keyword that narrows what may go somewhere. Nothing from this list means anything goes. */
const CONSTRAINING = [
  ...CONSTRAINT_KEYWORDS,
  'properties',
  'required',
  'items',
  'additionalProperties',
  'oneOf',
  'anyOf',
  'allOf',
  'enum',
  'const',
  '$ref',
] as const;

/**
 * A type in a position that has no key of its own.
 *
 * One shape serves three of those: a branch of a union, the items of an array, and the values of a
 * map. They are the same question — *what may go here* — asked without a name, and giving each its
 * own shape would triple this file for no gain.
 */
export interface TypeShape {
  /** The named type here, if it has one. Can be passed back to {@link fieldsOf}. */
  typeName?: string;
  /** The JSON type, where it is a plain value. */
  type?: string;
  title?: string;
  description?: string;
  /** The only value allowed — a discriminator, such as `call: "http"`. */
  const?: unknown;
  enum?: unknown[];
  default?: unknown;
  constraints?: TypeConstraints;
  /** The fields of this type, expanded inline. */
  fields?: TypeField[];
  /** The alternatives, when this is a choice rather than an object. */
  variants?: TypeShape[];
  /** What goes in the array, when this is one. */
  items?: TypeShape;
  keysAreFree?: boolean;
  /** What the map's values are, where the schema constrains them. */
  values?: TypeShape;
  /** True where the schema constrains nothing at all — any JSON is valid here. */
  anyValue?: boolean;
}

/** One field a type can carry: a {@link TypeShape} with a name and a requirement. */
export interface TypeField extends TypeShape {
  key: string;
  required: boolean;
  /**
   * False when `required` names a key that `properties` never declares. It happens: `McpClient`
   * requires `version` and declares `description`, because the property was renamed upstream and
   * the `required` list was not. Reported rather than dropped, so a caller can surface it.
   */
  declared: boolean;
}

/** Everything known about one position, without recursing. */
function describe(pointer: string): TypeShape {
  const schema = resolveSchemaAt(pointer);
  const shape: TypeShape = {};

  const name = typeNameAt(pointer);
  if (name !== undefined) shape.typeName = name;
  if (typeof schema.type === 'string') shape.type = schema.type;
  /* The position's own title and description win over its type's: `with.endpoint` says what this
     endpoint is for, `#/$defs/endpoint` says what an endpoint is in general. */
  if (typeof schema.title === 'string') shape.title = schema.title;
  if (typeof schema.description === 'string') shape.description = schema.description;
  if (schema.const !== undefined) shape.const = schema.const;
  if (Array.isArray(schema.enum)) shape.enum = [...schema.enum];
  if (schema.default !== undefined) shape.default = schema.default;

  const constraints: TypeConstraints = {};
  for (const keyword of TEXT_CONSTRAINTS) {
    const value = schema[keyword];
    if (typeof value === 'string') constraints[keyword] = value;
  }
    for (const keyword of NUMBER_CONSTRAINTS) {
    const value = schema[keyword];
    if (typeof value === 'number') constraints[keyword] = value;
  }
  if (Object.keys(constraints).length > 0) shape.constraints = constraints;

  const additional = schema.additionalProperties;
  const closed = additional === false || schema.unevaluatedProperties === false;

  const isUnion = schema.oneOf !== undefined || schema.anyOf !== undefined;

  if (!closed && !isUnion && schema.type === 'object') {
  const declares = Object.keys(schema.properties ?? {}).length > 0;
  if(additional !== undefined || !declares) shape.keysAreFree = true
  }

  /* A position the schema deliberately leaves open: `SchemaInline.document` is
     `{ description: "..." }` and nothing else, and an HTTP `body` may be any JSON. Without a marker
     a caller sees no type, no fields and no variants, and cannot tell "anything goes here" from
     "we failed to resolve this". */
  if (schema.type === undefined && !CONSTRAINING.some((keyword) => schema[keyword] !== undefined)) {
    shape.anyValue = true;
  }

  return shape;
}

/** Everything a position contains: fields, branches, items, map values — down to `depth`. */
function contentsOf(pointer: string, into: TypeShape): TypeShape {
  const schema = resolveSchemaAt(pointer);

  /* A position can be a choice AND declare properties of its own: `run` has `await` and `return`
     beside a `oneOf` of container/script/shell/workflow, and every Run table in the field reference
     lists all three. Reporting only the variants drops the shared keys silently. */
  const branches = schemaBranchesAt(pointer);
  if (branches !== undefined) {
    into.variants = branches.map((branch) => referenceOr(branch.pointer));
  }

  const fields = fieldsAt(pointer);
  if (fields.length > 0) into.fields = fields;

  /* An array's items and a map's values cost no depth. `depth` measures how deeply *objects and
     choices* nest, which is what a form renders as levels — "a list of strings" is not deeper than
     "a string" in any sense a reader experiences, and charging it a level meant
     `container.arguments` was cut while carrying nothing but `items: { type: string }`. */
  if (schema.items !== undefined) into.items = referenceOr(`${pointer}/items`);

  if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
    into.values = referenceOr(`${pointer}/additionalProperties`);
  }

  return into;
}

/**
 * A position, described — and expanded only if it has no name to be referenced by.
 *
 * A named type stops here: the caller resolves it from {@link definitions}. An unnamed one has
 * nowhere to be looked up, so its contents come inline.
 */
function referenceOr(pointer: string): TypeShape {
  const shape = describe(pointer);
  if (shape.typeName !== undefined) return shape;

  return contentsOf(pointer, shape);
}

function fieldsAt(pointer: string): TypeField[] {
  /* The type's own fields first, then what it inherits, each group in declaration order.
     A field is inherited when the winning declaration lives outside this type — `set` is declared
     under `#/$defs/setTask`, `timeout` under `#/$defs/taskBase`. Callers overwhelmingly want the
     distinguishing fields first: a form puts what makes the task that task above the shared seven. */
  const declared = schemaFieldsAt(pointer);
  const own = declared.filter((field) => field.pointer.startsWith(pointer));
  const inherited = declared.filter((field) => !field.pointer.startsWith(pointer));

  return [...own, ...inherited].map((field) => {
    const entry: TypeField = {
      key: field.key,
      required: field.required,
      declared: field.declared,
      ...describe(field.pointer),
    };

    /* A named type is referenced, not inlined — that is the whole point of the registry. */
    if (entry.typeName !== undefined) return entry;

    return contentsOf(field.pointer, entry) as TypeField;
  });
}

let registry: Readonly<Record<string, TypeDefinition>> | undefined;
/** One named type, as the registry holds it. */
export interface TypeDefinition extends TypeShape {
  typeName: string;
}

/**
 * Every field a type can carry: its own and everything it inherits, one level deep.
 *
 * A field whose value has a named type reports that name; look it up in {@link definitions}.
 * Answers `[]` for a type the schema does not name, and for one that is a *choice* rather than an
 * object — those carry `variants` instead.
 */
export function fieldsOf(typeName: string): TypeField[] {
  const pointer = pointerOf(typeName);
  return pointer === undefined ? [] : fieldsAt(pointer);
}

/** One named type: its fields, or its variants, plus whatever the schema says about it. */
export function definitionOf(typeName: string): TypeDefinition | undefined {
  const pointer = pointerOf(typeName);
  if (pointer === undefined) return undefined;

  const definition: TypeDefinition = { ...describe(pointer), typeName };
  return contentsOf(pointer, definition) as TypeDefinition;
}

/**
 * Every type reachable from a workflow, keyed by name — the whole vocabulary, once.
 *
 * Built by walking out from `Workflow` and the task types until nothing new is referenced, so it is
 * closed by construction: every `typeName` any definition mentions is a key in here. Around 248
 * types and 95 KB, built in roughly 45 ms, and memoised — a consumer loads it once at startup and
 * resolves references against it from then on.
 */
export function definitions(): Readonly<Record<string, TypeDefinition>> {
  if (registry !== undefined) return registry;

  const built: Record<string, TypeDefinition> = {};
  const queue = ['Workflow', ...taskTypeNames()];

  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || built[name] !== undefined) continue;

    const definition = definitionOf(name);
    if (definition === undefined) continue;
    built[name] = definition;

    /* Anything this definition names, including through its variants, items and map values. */
    const referenced = (shape: TypeShape): string[] =>
      [
        ...(shape.fields ?? []).flatMap((field) => [field.typeName, ...referenced(field)]),
        ...(shape.variants ?? []).flatMap((variant) => [variant.typeName, ...referenced(variant)]),
        ...(shape.items === undefined ? [] : [shape.items.typeName, ...referenced(shape.items)]),
        ...(shape.values === undefined ? [] : [shape.values.typeName, ...referenced(shape.values)]),
      ].filter((found): found is string => found !== undefined);

    for (const next of referenced(definition)) if (built[next] === undefined) queue.push(next);
  }

  registry = built;
  return registry;
}

/** The task types the spec defines, in the order the schema lists them. */
export function taskTypeNames(): string[] {
  return (schemaBranchesAt('#/$defs/task') ?? []).map(
    (branch) => branch.typeName ?? canonicalPointerAt(branch.pointer),
  );
}
