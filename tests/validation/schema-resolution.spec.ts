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
import { validate } from '../../src/lib/validation';
import {
  canonicalPointerAt,
  resolveSchemaAt,
  schemaBranchesAt,
  schemaFieldsAt,
  typeNameAt,
} from '../../src/lib/schema-resolution';

const CALL_HTTP = '#/$defs/callTask/oneOf/2';

describe('resolveSchemaAt', () => {
  /* Draft 2020-12 treats the keywords written beside a `$ref` as the more specific description of
     that position. `with.endpoint` is `{ title: HTTPEndpoint, description: ..., $ref: endpoint }`;
     resolving to the target and discarding the siblings silently relabels 88 positions in this
     schema, and at two sites loses `required` outright. */
  it('keeps the keywords written beside a $ref, in preference to the target', () => {
    const endpoint = resolveSchemaAt(`${CALL_HTTP}/allOf/1/properties/with/properties/endpoint`);

    expect(endpoint.title).toBe('HTTPEndpoint');
    expect(endpoint.description).toBe('The HTTP endpoint to send the request to.');
    expect(endpoint.oneOf).toHaveLength(3);
  });

  /* Every task is `allOf: [{$ref: taskBase}, {own properties}]`, and `taskBase` carries its own
     title. Merged the wrong way round, a DoTask calls itself TaskBase. */
  it('lets a position keep its own title over the one it composes from', () => {
    expect(resolveSchemaAt('#/$defs/doTask').title).toBe('DoTask');
    expect(resolveSchemaAt(CALL_HTTP).title).toBe('CallHTTP');
  });

  it('merges an allOf so inherited and own keys arrive as one property set', () => {
    const http = resolveSchemaAt(CALL_HTTP);

    expect(Object.keys(http.properties ?? {})).toEqual(
      expect.arrayContaining(['call', 'with', 'timeout', 'then', 'metadata']),
    );
  });

  it('leaves oneOf and anyOf alone, because choosing a branch needs a value', () => {
    expect(resolveSchemaAt('#/$defs/endpoint').oneOf).toHaveLength(3);
  });

  /* task -> taskList -> task. Without a guard this never returns. */
  it('survives the schema own recursive definitions', () => {
    expect(() => resolveSchemaAt('#/$defs/task')).not.toThrow();
  });

  it('answers with an empty schema for a position the document does not declare', () => {
    expect(resolveSchemaAt('#/$defs/callTask/properties/notAThing')).toEqual({});
  });
});

describe('schemaFieldsAt', () => {
  it('lists the keys a position declares, own and inherited, in declaration order', () => {
    const keys = schemaFieldsAt(CALL_HTTP).map((field) => field.key);

    expect(keys).toEqual(expect.arrayContaining(['call', 'with', 'if', 'input', 'timeout', 'then', 'metadata']));
  });

  /* The pointer is what makes the walk continue: once `allOf` is merged, a node's keys come from
     several places at once and the merged object is addressable by nothing. */
  it('reports where each key is actually declared, so a consumer can carry on walking', () => {
    const field = (key: string) => schemaFieldsAt(CALL_HTTP).find((candidate) => candidate.key === key);

    expect(field('with')?.pointer).toBe(`${CALL_HTTP}/allOf/1/properties/with`);
    expect(field('timeout')?.pointer).toBe('#/$defs/taskBase/properties/timeout');
  });

  it('says which keys are required, and agrees with the validator about it', () => {
    const valid = { call: 'http', with: { method: 'GET', endpoint: 'https://acme.io/v1' } };
    expect(() => validate('CallHTTP', valid)).not.toThrow();

    for (const field of schemaFieldsAt(CALL_HTTP).filter((candidate) => candidate.required)) {
      const without = { ...valid } as Record<string, unknown>;
      delete without[field.key];
      expect(() => validate('CallHTTP', without), `${field.key} should be required`).toThrow();
    }
  });

  /* `mcp.client` requires [name, version] but declares name and description: the property was
     renamed and `required` was left behind. A consumer that lists only declared keys drops a field
     that valid documents carry, so the key is reported with `declared: false`. */
  it('reports a required key the schema never declares, rather than dropping it', () => {
    const client = schemaFieldsAt(`#/$defs/callTask/oneOf/5/allOf/1/properties/with/properties/client`);
    const version = client.find((field) => field.key === 'version');

    expect(version).toBeDefined();
    expect(version?.required).toBe(true);
    expect(version?.declared).toBe(false);
  });

  it('resolves each key schema, so a consumer never re-implements the merge', () => {
    const endpoint = schemaFieldsAt(`${CALL_HTTP}/allOf/1/properties/with`).find((f) => f.key === 'endpoint');

    expect(endpoint?.schema.title).toBe('HTTPEndpoint');
    expect(endpoint?.schema.oneOf).toHaveLength(3);
  });
});

describe('schemaBranchesAt', () => {
  it('lists a union branches with the pointer and the name the validator knows each by', () => {
    const branches = schemaBranchesAt('#/$defs/callTask');

    expect(branches).toHaveLength(7);
    expect(branches?.[2]?.pointer).toBe(CALL_HTTP);
    expect(branches?.[2]?.typeName).toBe('CallHTTP');
  });

  it('treats anyOf as a union too', () => {
    expect(schemaBranchesAt('#/$defs/uriTemplate')).toHaveLength(2);
  });

  /* `#/$defs/duration` carries no `title` of its own, so a consumer deriving a name from the
     schema alone gets nothing here. The validator knows it as `Duration`. */
  it('names a definition the schema itself leaves untitled', () => {
    expect(resolveSchemaAt('#/$defs/duration').title).toBeUndefined();
    expect(schemaBranchesAt('#/$defs/duration')?.[0]?.typeName).toBe('DurationInline');
  });

  it('answers undefined where there is no union', () => {
    expect(schemaBranchesAt('#/$defs/taskBase')).toBeUndefined();
  });
});

describe('typeNameAt', () => {
  /* `timeout.after` is written as a `$ref` to `#/$defs/duration`, which carries no title of its
     own. Naming the reference site gives nothing; naming what it refers to gives `Duration`. */
  it('follows the $ref before naming, and answers where the schema has no title', () => {
    expect(canonicalPointerAt('#/$defs/timeout/properties/after')).toBe('#/$defs/duration');
    expect(typeNameAt('#/$defs/timeout/properties/after')).toBe('Duration');
  });

  it('falls back to the title the schema carries', () => {
    expect(typeNameAt('#/$defs/callTask/oneOf/2/allOf/1/properties/with')).toBe('HTTPArguments');
  });
});
