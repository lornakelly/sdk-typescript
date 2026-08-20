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

import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { workflowSchema } from '../../src/lib/schema';
import { preserveRefAnnotations, workflowSchemaForTooling } from '../../src/lib/schema-tooling';

/** Every `$ref` in a schema that has keywords written beside it. */
const siblingSites = (node: unknown, found: string[] = [], path = ''): string[] => {
  if (Array.isArray(node)) {
    node.forEach((item, index) => siblingSites(item, found, `${path}/${index}`));
  } else if (node !== null && typeof node === 'object') {
    const keys = Object.keys(node as object);
    if (keys.includes('$ref') && keys.length > 1) found.push(path);
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      siblingSites(value, found, `${path}/${key}`);
    }
  }
  return found;
};

describe('workflowSchemaForTooling', () => {
  /* The count is the point: it is the size of the problem, and it should fall to zero. */
  it('moves every $ref that had siblings, and leaves none behind', () => {
    expect(siblingSites(workflowSchema)).toHaveLength(88);
    expect(siblingSites(workflowSchemaForTooling)).toHaveLength(0);
  });

  it('keeps the annotations rather than discarding them', () => {
    const endpoint = (workflowSchemaForTooling.$defs as Record<string, any>).callTask.oneOf[2].allOf[1].properties.with
      .properties.endpoint;

    expect(endpoint.title).toBe('HTTPEndpoint');
    expect(endpoint.description).toBe('The HTTP endpoint to send the request to.');
    expect(endpoint.allOf).toEqual([{ $ref: '#/$defs/endpoint' }]);
  });

  /* `allOf` of a single subschema is that subschema, so the rewrite must not change what the schema
     accepts. Checked against a real validator rather than by argument. */
  it('accepts and rejects exactly what the original does', () => {
    const compile = (schema: object) => {
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      addFormats(ajv);
      return ajv.compile(schema);
    };

    const before = compile(workflowSchema);
    const after = compile(workflowSchemaForTooling);

    const document = {
      document: { dsl: '1.0.3', namespace: 'p', name: 'p', version: '1.0.0' },
      do: [{ callIt: { call: 'http', with: { method: 'GET', endpoint: 'https://acme.io/v1' } } }],
    };
    const missingWith = {
      document: { dsl: '1.0.3', namespace: 'p', name: 'p', version: '1.0.0' },
      do: [{ callIt: { call: 'http' } }],
    };

    expect(before(document)).toBe(true);
    expect(after(document)).toBe(true);
    expect(before(missingWith)).toBe(false);
    expect(after(missingWith)).toBe(false);
  });

  it('leaves a bare $ref alone, since it already means the same thing', () => {
    expect(preserveRefAnnotations({ $ref: '#/$defs/task' })).toEqual({ $ref: '#/$defs/task' });
  });

  it('appends to an existing allOf rather than replacing it', () => {
    expect(preserveRefAnnotations({ title: 'T', $ref: '#/a', allOf: [{ type: 'object' }] })).toEqual({
      title: 'T',
      allOf: [{ type: 'object' }, { $ref: '#/a' }],
    });
  });
});
