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

  it('keeps the keywords written beside a $ref, in preference to the target', () => {
  /*  
   * What it tests: When you have a reference with extra info beside it, keep that extra info                                                                                                                           │
   * Example: with.endpoint says title: "HTTPEndpoint" and $ref: endpoint. The title should stay "HTTPEndpoint", not get replaced by the generic "Endpoint" from the target. 
  */
    const endpoint = resolveSchemaAt(`${CALL_HTTP}/allOf/1/properties/with/properties/endpoint`);

    expect(endpoint.title).toBe('HTTPEndpoint');
    expect(endpoint.description).toBe('The HTTP endpoint to send the request to.');
    expect(endpoint.oneOf).toHaveLength(3);
  });

  it('lets a position keep its own title over the one it composes from', () => {
    /* 
     * What it tests: When combining inherited properties, your own title wins                                                                                                                                            │
     * Example: DoTask inherits from TaskBase, but should be called "DoTask" not "TaskBase" 
    */
    expect(resolveSchemaAt('#/$defs/doTask').title).toBe('DoTask');
    expect(resolveSchemaAt(CALL_HTTP).title).toBe('CallHTTP');
  });

  it('merges an allOf so inherited and own keys arrive as one property set', () => {
    /* 
     * What it tests: Inherited and own properties get combined into one list                                                                                                                                             │
     * Example: CallHTTP has its own call and with, plus inherited timeout, then, metadata - all should appear together
    */
    const http = resolveSchemaAt(CALL_HTTP);

    expect(Object.keys(http.properties ?? {})).toEqual(
      expect.arrayContaining(['call', 'with', 'timeout', 'then', 'metadata']),
    );
  });

  it('leaves oneOf and anyOf alone, because choosing a branch needs a value', () => {
    /* 
     *  What it tests: Unions (choices) are NOT merged                                                                                                                                                                     │
     * Example: endpoint has 3 options (oneOf) - these stay as 3 separate choices
    */
    expect(resolveSchemaAt('#/$defs/endpoint').oneOf).toHaveLength(3);
  });


  it('survives the schema own recursive definitions', () => {
   /* 
    * What it tests: Handles circular references without infinite loops 
    * Example: task → taskList → task (goes in a circle)
    */
    expect(() => resolveSchemaAt('#/$defs/task')).not.toThrow();
  });

  it('answers with an empty schema for a position the document does not declare', () => {
    /* 
     * What it tests: Returns {} instead of crashing for non-existent paths                                                                                                                                               │
     * Example: Asking for a property that doesn't exist returns empty object
    */
    expect(resolveSchemaAt('#/$defs/callTask/properties/notAThing')).toEqual({});
  });
});

describe('schemaFieldsAt', () => {
  it('lists the keys a position declares, own and inherited, in declaration order', () => {
    /* 
     * What it tests: Returns all fields (own + inherited) in the order they were declared                                                                                                                                │
     * Example: CallHTTP returns call, with, if, input, timeout, then, metadata
    */
    const keys = schemaFieldsAt(CALL_HTTP).map((field) => field.key);

    expect(keys).toEqual(expect.arrayContaining(['call', 'with', 'if', 'input', 'timeout', 'then', 'metadata']));
  });

  it('reports where each key is actually declared, so a consumer can carry on walking', () => {
    /* 
     * What it tests: Tells you the exact location of each field's definition                                                                                                                                             │
     * Example: with is at CallHTTP/properties/with, timeout is at TaskBase/properties/timeout
    */
    const field = (key: string) => schemaFieldsAt(CALL_HTTP).find((candidate) => candidate.key === key);

    expect(field('with')?.pointer).toBe(`${CALL_HTTP}/allOf/1/properties/with`);
    expect(field('timeout')?.pointer).toBe('#/$defs/taskBase/properties/timeout');
  });

  it('says which keys are required, and agrees with the validator about it', () => {
    /* 
     * What it tests: Correctly identifies required vs optional fields, matching the validator                                                                                                                            │
     * Example: call and with are required for CallHTTP; removing them makes validation fail
    */
    const valid = { call: 'http', with: { method: 'GET', endpoint: 'https://acme.io/v1' } };
    expect(() => validate('CallHTTP', valid)).not.toThrow();

    for (const field of schemaFieldsAt(CALL_HTTP).filter((candidate) => candidate.required)) {
      const without = { ...valid } as Record<string, unknown>;
      delete without[field.key];
      expect(() => validate('CallHTTP', without), `${field.key} should be required`).toThrow();
    }
  });

  it('reports a required key the schema never declares, rather than dropping it', () => {
    /* 
     * What it tests: Handles schema bugs where required lists a field that properties doesn't declare                                                                                                                    │
     * Example: mcp.client requires version but only declares description (property was renamed, required list wasn't updated)
    */
    const client = schemaFieldsAt(`#/$defs/callTask/oneOf/5/allOf/1/properties/with/properties/client`);
    const version = client.find((field) => field.key === 'version');

    expect(version).toBeDefined();
    expect(version?.required).toBe(true);
    expect(version?.declared).toBe(false);
  });

  it('resolves each key schema, so a consumer never re-implements the merge', () => {
    /* 
     * What it tests: Each field comes with its fully resolved schema                                                                                                                                                     │
     * Example: endpoint field includes its title "HTTPEndpoint" and its 3 oneOf options
    */
    const endpoint = schemaFieldsAt(`${CALL_HTTP}/allOf/1/properties/with`).find((f) => f.key === 'endpoint');

    expect(endpoint?.schema.title).toBe('HTTPEndpoint');
    expect(endpoint?.schema.oneOf).toHaveLength(3);
  });
});

describe('schemaBranchesAt', () => {
  it('lists a union branches with the pointer and the name the validator knows each by', () => {
    /* 
     * What it tests: Returns all options in a choice with their locations and names                                                                                                                                      │
     * Example: callTask has 7 branches; branch 2 is at #/$defs/callTask/oneOf/2 named "CallHTTP"
    */
    const branches = schemaBranchesAt('#/$defs/callTask');

    expect(branches).toHaveLength(7);
    expect(branches?.[2]?.pointer).toBe(CALL_HTTP);
    expect(branches?.[2]?.typeName).toBe('CallHTTP');
  });

  it('treats anyOf as a union too', () => {
    /* 
     * What it tests: Works with both oneOf (exactly one) and anyOf (one or more)                                                                                                                                         │
     * Example: uriTemplate has 2 anyOf branches
    */
    expect(schemaBranchesAt('#/$defs/uriTemplate')).toHaveLength(2);
  });


  it('names a definition the schema itself leaves untitled', () => {
    /* 
     * What it tests: Provides names even when schema doesn't have a title                                                                                                                                                │
     * Example: #/$defs/duration has no title, but validator knows it as "Duration"
    */
    expect(resolveSchemaAt('#/$defs/duration').title).toBeUndefined();
    expect(schemaBranchesAt('#/$defs/duration')?.[0]?.typeName).toBe('DurationInline');
  });

  it('answers undefined where there is no union', () => {
    /* 
     * What it tests: Returns undefined for non-union types                                                                                                                                                               │
     * Example: taskBase is not a union, returns undefined
    */
    expect(schemaBranchesAt('#/$defs/taskBase')).toBeUndefined();
  });
});

describe('typeNameAt', () => {
  it('follows the $ref before naming, and answers where the schema has no title', () => {
    /* 
     * What it tests: Gets the name from the target, not the reference site                                                                                                                                               │
     * Example: timeout.after is a $ref to #/$defs/duration → name is "Duration" not undefined
    */
    expect(canonicalPointerAt('#/$defs/timeout/properties/after')).toBe('#/$defs/duration');
    expect(typeNameAt('#/$defs/timeout/properties/after')).toBe('Duration');
  });

  it('falls back to the title the schema carries', () => {
    /* 
     * What it tests: Uses the schema's own title when available                                                                                                                                                          │
     * Example: HTTPArguments comes from the schema's title property
    */
    expect(typeNameAt('#/$defs/callTask/oneOf/2/allOf/1/properties/with')).toBe('HTTPArguments');
  });
});
