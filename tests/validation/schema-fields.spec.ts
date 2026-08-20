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

import { describe, expect, it } from 'vitest';
import { validate } from '../../src/lib/validation';
import { definitionOf, definitions, fieldsOf, taskTypeNames } from '../../src/lib/schema-fields';
import type { TypeShape } from '../../src/lib/schema-fields';

const keys = (typeName: string) => fieldsOf(typeName).map((field) => field.key);
const field = (typeName: string, key: string) => fieldsOf(typeName).find((f) => f.key === key);

describe('taskTypeNames', () => {
  it('lists the task types the spec defines, from the schema', () => {
    expect(taskTypeNames()).toEqual([
      'CallTask',
      'DoTask',
      'ForkTask',
      'EmitTask',
      'ForTask',
      'ListenTask',
      'RaiseTask',
      'RunTask',
      'SetTask',
      'SwitchTask',
      'TryTask',
      'WaitTask',
    ]);
  });
});

describe('fieldsOf', () => {
  it('gives a task its own field first, then everything it inherits', () => {
    expect(keys('SetTask')).toEqual(['set', 'if', 'input', 'output', 'export', 'timeout', 'then', 'metadata']);
  });

  /* The inheritance is the point: `timeout` is not written anywhere near `setTask`, it arrives
     through an `allOf` on `taskBase`. */
  it('merges inherited fields rather than making the caller chase the allOf', () => {
    expect(field('SetTask', 'timeout')).toBeDefined();
    expect(field('CallHTTP', 'timeout')).toBeDefined();
  });

  it('says which fields are required, and agrees with the validator', () => {
    const valid = { call: 'http', with: { method: 'GET', endpoint: 'https://acme.io/v1' } };
    expect(() => validate('CallHTTP', valid)).not.toThrow();

    for (const required of fieldsOf('CallHTTP').filter((f) => f.required)) {
      const without = { ...valid } as Record<string, unknown>;
      delete without[required.key];
      expect(() => validate('CallHTTP', without), `${required.key} should be required`).toThrow();
    }
  });

  /* A named type is *referenced*, not inlined — one level, and the registry holds the rest. */
  it('names a field type rather than expanding it', () => {
    expect(field('CallHTTP', 'with')?.typeName).toBe('HTTPArguments');
    expect(field('CallHTTP', 'with')?.fields).toBeUndefined();
    expect(keys('HTTPArguments')).toEqual(['method', 'endpoint', 'headers', 'body', 'query', 'output', 'redirect']);
  });

  /* Draft 2020-12: the keywords beside a `$ref` describe *that position* and win over the target.
     The registry supplies the shape; the field supplies what it is for. */
  it('keeps a field own title and description alongside the reference', () => {
    const endpoint = field('HTTPArguments', 'endpoint');

    expect(endpoint?.typeName).toBe('Endpoint');
    expect(endpoint?.title).toBe('HTTPEndpoint');
    expect(endpoint?.description).toBe('The HTTP endpoint to send the request to.');
    expect(definitionOf('Endpoint')?.description).toBe('Represents an endpoint.');
  });

  /* `McpClient` requires [name, version] and declares name and description: the property was renamed
     upstream and `required` was left behind. Dropping it would hide a field valid documents carry. */
  it('reports a required field the schema never declares, rather than dropping it', () => {
    expect(field('McpClient', 'version')).toMatchObject({ required: true, declared: false });
  });

  it('answers with nothing for a type it does not know', () => {
    expect(fieldsOf('NotAType')).toEqual([]);
    expect(definitionOf('NotAType')).toBeUndefined();
  });
});

describe('definitions', () => {
  /* Closed by construction: every name any definition mentions is a key in here. Without that a
     consumer resolving `registry[field.typeName]` would hit undefined and have no recourse. */
  it('is closed — every name it mentions is a key in it', () => {
    const registry = definitions();
    const dangling: string[] = [];

    const walk = (shape: TypeShape, from: string): void => {
      for (const child of [
        ...(shape.fields ?? []),
        ...(shape.variants ?? []),
        ...(shape.items ? [shape.items] : []),
        ...(shape.values ? [shape.values] : []),
      ]) {
        if (child.typeName !== undefined && registry[child.typeName] === undefined) {
          dangling.push(`${from} -> ${child.typeName}`);
        }
        walk(child, from);
      }
    };
    for (const [name, definition] of Object.entries(registry)) walk(definition, name);

    expect(dangling).toEqual([]);
  });

  it('covers the workflow document as well as the task types', () => {
    const registry = definitions();

    expect(registry.Workflow).toBeDefined();
    for (const task of taskTypeNames()) expect(registry[task], task).toBeDefined();
  });

  it('is memoised, because a consumer loads it once at startup', () => {
    expect(definitions()).toBe(definitions());
  });

  /* A choice is a definition too — its `variants` are how a caller offers the alternatives. */
  it('holds a union as its alternatives', () => {
    expect(definitionOf('Endpoint')?.variants?.map((v) => v.typeName)).toEqual([
      'RuntimeExpression',
      'UriTemplate',
      'EndpointConfiguration',
    ]);
    expect(definitionOf('CallTask')?.variants?.map((v) => v.typeName)).toEqual([
      'CallAsyncAPI',
      'CallGRPC',
      'CallHTTP',
      'CallOpenAPI',
      'CallA2A',
      'CallMCP',
      'CallFunction',
    ]);
  });

  /* `run` declares `await` and `return` beside a `oneOf` of four. Every Run table in the authored
     field reference lists all three; reporting only the variants drops the shared keys silently. */
  it('reports shared keys as well as alternatives where a position is both', () => {
    const run = field('RunTask', 'run');
    const definition = definitionOf(run?.typeName ?? '');

    expect(definition?.fields?.map((f) => f.key)).toEqual(['await', 'return']);
    expect(definition?.variants?.map((v) => v.typeName)).toEqual([
      'RunContainer',
      'RunScript',
      'RunShell',
      'RunWorkflow',
    ]);
    expect(definition?.fields?.find((f) => f.key === 'await')?.default).toBe(true);
  });
});

describe('what a dynamic form needs', () => {
  it('reports a const, so a discriminator can be set', () => {
    expect(field('CallHTTP', 'call')?.const).toBe('http');
  });

  it('carries enum and default on a variant, not just on a field', () => {
    const choice = definitionOf('FlowDirective')?.variants?.find((v) => v.typeName === 'FlowDirectiveEnum');

    expect(definitionOf('FlowDirectiveEnum')?.enum).toEqual(['continue', 'exit', 'end']);
    expect(choice?.typeName).toBe('FlowDirectiveEnum');
  });

  /* `arguments` is a named type, so the field references it and the array's contents live on the
     definition — which is the registry model working, and the one-line join a caller makes. */
  it('says what goes in an array, via the reference', () => {
    const args = fieldsOf('Container').find((f) => f.key === 'arguments');

    expect(args?.typeName).toBe('ContainerArguments');
    expect(definitionOf('ContainerArguments')?.type).toBe('array');
    expect(definitionOf('ContainerArguments')?.items?.type).toBe('string');
  });

  /* Without this a free-form map is indistinguishable from an object whose fields we failed to
     find. The DSL declares it two ways and only one is explicit: `metadata` says
     `additionalProperties: true`, while `container.environment` is a bare `type: object`. */
  it('distinguishes a map from an object, explicit or implicit', () => {
    expect(definitionOf('TaskMetadata')?.keysAreFree).toBe(true);
    expect(definitionOf('ContainerEnvironment')?.keysAreFree).toBe(true);
    expect(definitionOf('TaskBaseInput')?.keysAreFree).toBeUndefined();
    expect(definitionOf('TaskBaseInput')?.fields?.length).toBeGreaterThan(0);
  });

  it('carries the validation keywords a form checks against', () => {
    const port = fieldsOf('WithGRPCService').find((f) => f.key === 'port');
    expect(port?.constraints).toMatchObject({ minimum: 0, maximum: 65_535 });
  });

  /* `SchemaInline.document` is `{ description: "..." }` and nothing else: any JSON is valid there,
     and without a marker that is indistinguishable from a position we failed to resolve. */
  it('marks a position the schema deliberately leaves open', () => {
    expect(fieldsOf('SchemaInline').find((f) => f.key === 'document')?.anyValue).toBe(true);
    expect(field('SetTask', 'if')?.anyValue).toBeUndefined();
  });
});

describe('enough to build a form from', () => {
  /** The decision a form makes at each position, resolving references through the registry. */
  const control = (shape: TypeShape, registry: Readonly<Record<string, TypeShape>>): string => {
    const resolved = shape.typeName === undefined ? shape : { ...registry[shape.typeName], ...shape };

    if (resolved.const !== undefined) return 'fixed';
    if (resolved.enum) return 'select';
    if (resolved.variants) return 'picker';
    if (resolved.keysAreFree) return 'key/value';
    if (resolved.fields) return 'fieldset';
    if (resolved.type === 'array') return resolved.items ? 'list' : 'UNDECIDABLE(array without items)';
    if (resolved.anyValue) return 'json';
    if (['string', 'boolean', 'integer', 'number'].includes(resolved.type ?? '')) return 'input';
    return `UNDECIDABLE(${resolved.type ?? 'no type'})`;
  };

  /* The acceptance test for the whole API: walk a task the way a form would — following references
     into the registry — and fail if any position yields no control. A gap is not cosmetic; it is a
     field the form cannot render. */
  it.each(['SetTask', 'RunTask', 'CallHTTP'])('leaves nothing undecidable in %s', (typeName) => {
    const registry = definitions();
    const seen = new Set<string>();
    const undecidable: string[] = [];

    const walk = (shape: TypeShape, path: string): void => {
      const verdict = control(shape, registry);
      if (verdict.startsWith('UNDECIDABLE')) undecidable.push(`${path} ${verdict}`);

      if (shape.typeName !== undefined) {
        if (seen.has(shape.typeName)) return;
        seen.add(shape.typeName);
        const definition = registry[shape.typeName];
        if (definition !== undefined) walk({ ...definition, typeName: undefined }, path);
        return;
      }

      for (const f of shape.fields ?? []) walk(f, `${path}.${f.key}`);
      for (const [i, v] of (shape.variants ?? []).entries()) walk(v, `${path}#${v.typeName ?? i}`);
      if (shape.items) walk(shape.items, `${path}[]`);
      if (shape.values) walk(shape.values, `${path}{}`);
    };

    for (const f of fieldsOf(typeName)) walk(f, `${typeName}.${f.key}`);

    expect(undecidable).toEqual([]);
  });
});
