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

/**
 * The DSL schema, rewritten so that JSON Schema tooling written for older drafts keeps the
 * annotations this schema attaches to individual positions.
 *
 * **The problem.** The DSL schema is draft 2020-12, where keywords written *beside* a `$ref`
 * describe that position and take precedence over the target. `with.endpoint` is written:
 *
 * ```json
 * { "title": "HTTPEndpoint",
 *   "description": "The HTTP endpoint to send the request to.",
 *   "$ref": "#/$defs/endpoint" }
 * ```
 *
 * Draft-07 says a `$ref` replaces everything beside it, so tooling built on those semantics — which
 * includes `vscode-json-languageservice`, and therefore the JSON and YAML language services behind
 * most editors — silently drops the title and description and shows the target's generic ones. It
 * happens at **88 positions** in this schema, and the symptom is a mislabelled field rather than an
 * error, so nobody notices.
 *
 * **The rewrite.** Every `{ ...siblings, $ref }` becomes `{ ...siblings, allOf: [{ $ref }] }`. Older
 * semantics understand `allOf`, so the siblings survive as annotations on a wrapper, and what the
 * schema *accepts* is unchanged — `allOf` of one subschema is that subschema.
 *
 * Measured: 88 positions rewritten, identical validation and identical completions, and
 * `with.endpoint` reads its own sentence again.
 *
 * **Use {@link workflowSchema}, not this, for validating** — that is the document {@link validate}
 * enforces. This exists for editors, language servers and documentation tooling.
 */
export const workflowSchemaForTooling: SchemaObject = preserveRefAnnotations(workflowSchema);

/**
 * Move a `$ref`'s siblings onto a wrapper that pre-2019 tooling reads.
 *
 * Exported for callers holding a schema this package does not ship — a spec-repo copy, or a future
 * DSL version — but {@link workflowSchemaForTooling} is what most consumers want.
 */
export function preserveRefAnnotations<T>(node: T): T {
  if (Array.isArray(node)) return node.map((item) => preserveRefAnnotations(item)) as T;
  if (node === null || typeof node !== 'object') return node;

  const rewritten: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node as Record<string, unknown>)) {
    rewritten[keyword] = preserveRefAnnotations(value);
  }

  /* Only a `$ref` that has something beside it needs moving; a bare `$ref` already means what it
     says under every draft. */
  if (typeof rewritten.$ref !== 'string' || Object.keys(rewritten).length === 1) return rewritten as T;

  const { $ref, ...siblings } = rewritten;
  const existing = Array.isArray(siblings.allOf) ? siblings.allOf : [];

  return { ...siblings, allOf: [...existing, { $ref }] } as T;
}
