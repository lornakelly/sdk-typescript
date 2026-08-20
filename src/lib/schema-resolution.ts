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
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { validationPointers } from './generated/validation';
import { workflowSchema } from './schema';

/**
 * Navigating the DSL schema: resolving a position, listing what it declares, and naming it.
 *
 * This exists so that no consumer has to re-implement JSON Schema semantics to find out what the
 * spec allows somewhere. Two rules below are easy to get subtly wrong and both fail *silently* —
 * a mislabelled field rather than an error:
 *
 *   1. **A `$ref`'s siblings win over its target.** Draft 2020-12 treats keywords written beside a
 *      `$ref` as the more specific description of that position. 88 positions in this schema carry
 *      siblings; discarding them relabels every one, and loses `required` at two of them.
 *   2. **A position's own keywords win over what it composes from.** Every task is
 *      `allOf: [{$ref: taskBase}, {own properties}]`, and `taskBase` has its own title — merged the
 *      wrong way round, a `DoTask` reports itself as `TaskBase`.
 *
 * Everything here is derived from {@link workflowSchema} at runtime, so a DSL bump changes nothing
 * in this file.
 */

/**
 * A JSON Schema object, as this package hands it back.
 *
 * Deliberately not AJV's `ResolvedSchema`: AJV is an implementation detail of validation, and a
 * consumer of these functions should not need its types installed to read a title. The index
 * signature keeps every other keyword reachable.
 */
export interface ResolvedSchema {
  [keyword: string]: unknown;
  $ref?: string;
  type?: string | string[];
  title?: string;
  description?: string;
  properties?: Record<string, ResolvedSchema>;
  required?: string[];
  items?: ResolvedSchema;
  additionalProperties?: boolean | ResolvedSchema;
  oneOf?: ResolvedSchema[];
  anyOf?: ResolvedSchema[];
  allOf?: ResolvedSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  format?: string;
}

/** The name the validator knows a position by, keyed by pointer fragment. */
const typeNames = new Map<string, string>(
  Object.entries(validationPointers).map(([name, url]) => [url.slice(url.indexOf('#')), name]),
);

const unescape = (token: string): string => token.replaceAll('~1', '/').replaceAll('~0', '~');
const escape = (token: string): string => token.replaceAll('~', '~0').replaceAll('/', '~1');

/** The subschema at a pointer, exactly as written — the `$ref` is not followed. */
function nodeAt(pointer: string): ResolvedSchema | undefined {
  let node: unknown = workflowSchema as ResolvedSchema;

  for (const token of pointer
    .replace(/^[^#]*#/, '')
    .split('/')
    .slice(1)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[unescape(token)];
  }

  return node as ResolvedSchema | undefined;
}

/** `oneOf`/`anyOf` are deliberately never merged: choosing a branch needs a value, not a schema. */
function mergeInto(base: ResolvedSchema, over: ResolvedSchema): ResolvedSchema {
  const merged: ResolvedSchema = { ...base, ...over };

  const properties = { ...base.properties, ...over.properties };
  if (Object.keys(properties).length > 0) merged.properties = properties;

  const required = [...new Set([...(base.required ?? []), ...(over.required ?? [])])];
  if (required.length > 0) merged.required = required;
  else delete merged.required;

  delete merged.allOf;
  delete merged.$ref;
  return merged;
}

function resolve(node: ResolvedSchema | undefined, seen: ReadonlySet<string>): ResolvedSchema {
  if (node === undefined) return {};

  /* Everything this position composes from, built separately from its own keywords so that the
     last step can be the rule: what is written HERE wins. */
  let composed: ResolvedSchema = {};

  if (typeof node.$ref === 'string' && !seen.has(node.$ref)) {
    composed = resolve(nodeAt(node.$ref), new Set([...seen, node.$ref]));
  }

  for (const part of (node.allOf ?? []) as ResolvedSchema[]) {
    composed = mergeInto(composed, resolve(part, seen));
  }

  const own: ResolvedSchema = { ...node };
  delete own.$ref;
  delete own.allOf;

  return mergeInto(composed, own);
}

/**
 * What the schema means at a pointer: `$ref` followed with its siblings winning, `allOf` flattened.
 *
 * A position the document does not declare resolves to `{}` rather than throwing — a consumer
 * walking a schema will read positions that a given DSL version does not carry, and taking the
 * whole caller down for one of them is never the useful answer.
 */
export function resolveSchemaAt(pointer: string): ResolvedSchema {
  return resolve(nodeAt(pointer), new Set([pointer]));
}

/**
 * Where a position's definition actually lives, after following any `$ref` chain.
 *
 * `#/$defs/taskBase/properties/timeout/oneOf/0` is a `$ref` to `#/$defs/timeout`; a consumer asking
 * "what type is this" means the target, not the reference site.
 */
export function canonicalPointerAt(pointer: string): string {
  const seen = new Set<string>();
  let current = pointer;

  for (;;) {
    if (seen.has(current)) return current;
    seen.add(current);

    const ref = nodeAt(current)?.$ref;
    if (typeof ref !== 'string') return current;
    current = ref;
  }
}

/**
 * The name the validator knows a position by, when it has one.
 *
 * The `$ref` chain is followed first, so a field that is written as a reference is named by what it
 * refers to. Falls back to the schema's own `title`, which covers 166 of the 171 named positions;
 * the map is what answers for the handful the schema leaves untitled, `#/$defs/duration` among them.
 */
export function typeNameAt(pointer: string): string | undefined {
  const canonical = canonicalPointerAt(pointer);

  return typeNames.get(canonical) ?? typeNames.get(pointer) ?? (resolveSchemaAt(pointer).title as string | undefined);
}

/** One key a position declares. */
export interface SchemaField {
  key: string;
  /** Where the winning declaration lives — the address a consumer continues walking from. */
  pointer: string;
  required: boolean;
  /**
   * False when `required` names a key that `properties` never declares. It happens: `mcp.client`
   * requires `version` and declares `description`, because the property was renamed upstream and
   * the `required` list was not. Reported rather than dropped, so a consumer can surface it.
   */
  declared: boolean;
  typeName?: string;
  /** Already resolved, so a consumer never re-implements the merge. */
  schema: ResolvedSchema;
}

/**
 * Where `key` is declared under `pointer`.
 *
 * Once `allOf` is merged a node's keys come from several places at once — `timeout` from
 * `#/$defs/taskBase`, `with` from `#/$defs/callTask/oneOf/2/allOf/1` — and the merged object is
 * addressable by nothing. Later parts of an `allOf` win, matching the merge order.
 */
function childPointer(pointer: string, key: string): string | undefined {
  const seen = new Set<string>();

  const search = (at: string): string | undefined => {
    if (seen.has(at)) return undefined;
    seen.add(at);

    const node = nodeAt(at);
    if (node === undefined) return undefined;

    let found: string | undefined;

    if (typeof node.$ref === 'string') found = search(node.$ref);
    (node.allOf ?? []).forEach((_: unknown, index: number) => {
      found = search(`${at}/allOf/${index}`) ?? found;
    });
    if (node.properties?.[key] !== undefined) found = `${at}/properties/${escape(key)}`;

    return found;
  };

  return search(pointer);
}

/** Every key the schema allows at a pointer, resolved, in declaration order. */
export function schemaFieldsAt(pointer: string): SchemaField[] {
  const resolved = resolveSchemaAt(pointer);
  const declared = Object.keys(resolved.properties ?? {});
  const required = new Set<string>(resolved.required ?? []);

  /* Declared keys first, then any the `required` list names but `properties` never declares. */
  const keys = [...declared, ...[...required].filter((key) => !declared.includes(key))];

  return keys.map((key) => {
    const at = childPointer(pointer, key);
    const field: SchemaField = {
      key,
      pointer: at ?? `${pointer}/properties/${escape(key)}`,
      required: required.has(key),
      declared: declared.includes(key),
      schema: at === undefined ? {} : resolveSchemaAt(at),
    };

    const name = at === undefined ? undefined : typeNames.get(at);
    if (name !== undefined) field.typeName = name;
    return field;
  });
}

/** One member of a `oneOf`/`anyOf`. */
export interface SchemaBranch {
  index: number;
  pointer: string;
  typeName?: string;
  /** Already resolved. */
  schema: ResolvedSchema;
}

/** The branches of the union at a pointer, or `undefined` where there is no union. */
export function schemaBranchesAt(pointer: string): SchemaBranch[] | undefined {
  const resolved = resolveSchemaAt(pointer);
  const keyword = resolved.oneOf !== undefined ? 'oneOf' : resolved.anyOf !== undefined ? 'anyOf' : undefined;
  if (keyword === undefined) return undefined;

  /* The branches live where the union is *declared*, which is not always where it was asked for:
     `with.endpoint` is a `$ref` to `#/$defs/endpoint`, and its branches are at
     `#/$defs/endpoint/oneOf/N`. Addressing them relative to the reference site produces pointers
     that resolve to nothing, and the branch comes back empty. */
  const base = canonicalPointerAt(pointer);

  return (resolved[keyword] as ResolvedSchema[]).map((_, index) => {
    const at = `${base}/${keyword}/${index}`;
    const branch: SchemaBranch = { index, pointer: at, schema: resolveSchemaAt(at) };

    const name = typeNameAt(at);
    if (name !== undefined) branch.typeName = name;
    return branch;
  });
}
