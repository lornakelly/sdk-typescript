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

import type { SchemaObject } from 'ajv';
import { workflowSchema } from './schema';

/** A JSON pointer reference token, with `~1` and `~0` unescaped (RFC 6901 §3). */
const unescapeToken = (token: string): string => token.replaceAll('~1', '/').replaceAll('~0', '~');

/** The raw node at a JSON pointer, with nothing resolved. */
function nodeAt(pointer: string): SchemaObject | undefined {
  if (!pointer || pointer === '#') return workflowSchema;

  const path = pointer.replace(/^[^#]*#/, '');
  let node: unknown = workflowSchema;

  for (const token of path.split('/').slice(1)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[unescapeToken(token)];
  }

  return node as SchemaObject | undefined;
}

/** Fold one `allOf` part into the accumulator, unioning `properties` and `required`. */
function mergePart(accumulator: SchemaObject, part: SchemaObject): SchemaObject {
  const merged: SchemaObject = { ...accumulator, ...part };

  const properties = { ...accumulator.properties, ...part.properties };
  if (Object.keys(properties).length > 0) merged.properties = properties;

  const required = [...new Set([...(accumulator.required ?? []), ...(part.required ?? [])])];
  if (required.length > 0) merged.required = required;

  return merged;
}

/**
 * The schema `node` describes, with `$ref` followed and `allOf` merged.
 *
 * Use this when you already hold a subschema — walking into `properties[key]`, `items`, or a
 * `oneOf` branch you have selected. Use {@link resolveSchemaAt} to start from a pointer.
 *
 * **`oneOf` and `anyOf` are returned untouched.** Deciding which branch a value belongs to requires
 * the value, and the tie-breaking rules are the consumer's: a form asks the author when it cannot
 * tell, a validator rejects. {@link validate} answers that question for any named type.
 *
 * @param node the subschema to resolve. A node this schema does not describe resolves to the empty
 *   schema rather than throwing, because a consumer walking a document will meet keys this schema
 *   version does not declare.
 * @param seen the `$ref`s already followed on this path, so the schema's own recursion
 *   (`task` → `taskList` → `task`) terminates.
 */
export function resolveSchema(node: SchemaObject, seen: ReadonlySet<string> = new Set()): SchemaObject {
  if (node === null || typeof node !== 'object') return {};

  if (typeof node.$ref === 'string') {
    /* A cycle resolves to the empty schema, which permits anything — the same answer a consumer
       gets by choosing to stop walking, rather than a crash or a lie about the shape. */
    if (seen.has(node.$ref)) return {};

    const { $ref, ...siblings } = node;
    const target = nodeAt($ref) ?? {};

    /* Siblings win: in draft 2020-12 `$ref` no longer replaces the keywords written beside it, and
       those are the more specific description of this position. */
    return { ...resolveSchema(target, new Set([...seen, $ref])), ...siblings };
  }

  if (Array.isArray(node.allOf)) {
    const { allOf, ...ownKeywords } = node;

    /* The node's own keywords fold in last so they win over the parts — the same precedence a
       sibling of `$ref` gets, and for the same reason. */
    return [...allOf.map((part: SchemaObject) => resolveSchema(part, seen)), ownKeywords].reduce(
      mergePart,
      {} as SchemaObject,
    );
  }

  return node;
}

/**
 * The schema at a JSON pointer into the DSL schema, with `$ref` followed and `allOf` merged.
 *
 * The pointer is resolved against {@link workflowSchema} — the same document {@link validate}
 * enforces — so a consumer never has to choose between navigating the schema and agreeing with the
 * validator.
 *
 * @param pointer an RFC 6901 JSON pointer, with or without a leading `#`
 *   (`#/$defs/callTask`, `/$defs/callTask`).
 * @returns the resolved schema, or `undefined` when the pointer addresses nothing.
 */
export function resolveSchemaAt(pointer: string): SchemaObject | undefined {
  const node = nodeAt(pointer);
  return node === undefined ? undefined : resolveSchema(node);
}
