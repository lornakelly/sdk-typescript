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

import { resolveSchema, resolveSchemaAt } from '../../src/lib/schema-resolver';
import { workflowSchema } from '../../src/lib/schema';
import { validate } from '../../src/lib/validation';

/* The `call: http` branch. Written literally rather than derived, so the test still means something
   if the resolver's own pointer handling is what breaks. */
const CALL_HTTP = '#/$defs/callTask/oneOf/2';

describe('resolveSchemaAt', () => {
  it('returns the schema at a pointer', () => {
    expect(resolveSchemaAt('#/$defs/callTask')?.title).toBe('CallTask');
  });

  it('returns undefined for a pointer that does not resolve', () => {
    expect(resolveSchemaAt('#/$defs/notARealDefinition')).toBeUndefined();
  });

  it('follows a $ref to the definition it names', () => {
    const task = resolveSchemaAt('#/$defs/taskList/items/additionalProperties');

    expect(task?.$ref).toBeUndefined();
    expect(task?.title).toBe('Task');
  });

  it('keeps keywords written beside a $ref', () => {
    /* In draft 2020-12 a `$ref` no longer replaces its siblings, and the sibling is the more
       specific description of this position. */
    expect(resolveSchemaAt('#/properties/input')?.title).toBe('Input');
  });

  it('merges allOf so a task branch carries its taskBase keys', () => {
    /* The reason the export is worth having: a call task is `allOf [taskBase, { call, with }]`, so
       without the merge a consumer cannot tell that `timeout` is legal on an HTTP call. */
    const http = resolveSchemaAt(CALL_HTTP);

    expect(Object.keys(http?.properties ?? {})).toEqual(
      expect.arrayContaining(['if', 'input', 'output', 'export', 'timeout', 'metadata', 'then', 'call', 'with']),
    );
    expect(http?.allOf).toBeUndefined();
  });

  it('leaves oneOf for the consumer to resolve', () => {
    /* Choosing a branch needs the value being described and the tie-break is consumer policy —
       `validate(typeName, value)` is where that question is answered. */
    expect(resolveSchemaAt('#/$defs/callTask')?.oneOf).toHaveLength(7);
  });

  it('terminates on the schema’s own recursion', () => {
    /* `task` -> `taskList` -> `task`. Without a cycle guard this overflows the stack. */
    expect(resolveSchemaAt('#/$defs/taskList')).toBeDefined();
  });

  it('resolves every definition and every union branch', () => {
    for (const name of Object.keys(workflowSchema.$defs ?? {})) {
      expect(resolveSchemaAt(`#/$defs/${name}`), name).toBeDefined();
    }
  });
});

describe('resolveSchema', () => {
  it('resolves a node the caller already holds', () => {
    const callTask = resolveSchemaAt('#/$defs/callTask')!;
    const branch = resolveSchema(callTask.oneOf![2]);

    expect(Object.keys(branch.properties ?? {})).toContain('call');
  });

  it('treats a node the schema does not describe as the empty schema', () => {
    /* A consumer walking `properties[key]` meets `undefined` whenever the document carries a key
       this schema version does not declare. Throwing there would take down whatever is rendering. */
    expect(resolveSchema(undefined as never)).toEqual({});
  });
});

describe('the merged result agrees with validate()', () => {
  /* A resolver that agrees with itself proves nothing. Every probe starts from a document the
     validator accepts and removes exactly one key, so the only thing that can change the verdict is
     the removal — filling with `{}` instead would make every probe throw for the wrong reason. */
  const validCall = { call: 'http', with: { endpoint: 'https://example.test', method: 'GET' } };

  it('starts from a document validate() accepts', () => {
    expect(() => validate('CallHTTP', validCall)).not.toThrow();
  });

  it('does not claim a requirement validate() will not enforce', () => {
    const required = (resolveSchemaAt(CALL_HTTP)?.required ?? []) as string[];
    expect(required.length).toBeGreaterThan(0);

    for (const omitted of required) {
      const withoutKey = Object.fromEntries(Object.entries(validCall).filter(([key]) => key !== omitted));

      expect(
        () => validate('CallHTTP', withoutKey),
        `the merge calls ${omitted} required, so removing it must be rejected`,
      ).toThrow();
    }
  });
});
