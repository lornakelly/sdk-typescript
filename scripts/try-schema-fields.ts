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

/*
 * TEMPORARY — proof-of-concept scratch tool, delete before this branch merges.
 *
 * Exists so somebody pulling this branch can see what the schema-fields API answers without
 * wiring up the editor. Reads the schema at runtime like everything else here; generates nothing.
 *
 *   npx tsx scripts/try-schema-fields.ts                 # list the task types
 *   npx tsx scripts/try-schema-fields.ts SetTask         # fields of one type, one level
 *   npx tsx scripts/try-schema-fields.ts CallHTTP --json # the same, as the raw object
 *
 * The two above answer one level, with named types referenced rather than inlined. What an
 * editor actually renders a form from is that answer joined against `definitions()` and followed
 * all the way down:
 *
 *   npx tsx scripts/try-schema-fields.ts SetTask --tree  # the whole thing, readable
 *   npx tsx scripts/try-schema-fields.ts SetTask --full  # the whole thing, as JSON to pipe
 */

import { definitionOf, definitions, fieldsOf, taskTypeNames } from '../src/lib/schema-fields';
import type { TypeField, TypeShape } from '../src/lib/schema-fields';

const [, , typeName, ...flags] = process.argv;
const asJson = flags.includes('--json');
const asTree = flags.includes('--tree');
const asFull = flags.includes('--full');
/**
 * NOTE in editor we would just need to add the following
 * const REGISTRY = definitions();
 * const resolve = (shape: TypeShape): TypeShape => shape.typeName === undefined ? shape : {...REGISTRY[shape.typeName], ...shape };
 * 
 */

/*
 * The join a consumer does: a field names its type, and the type is looked up in the registry.
 * This is the entire cost of the referenced design — deliberately kept to these few lines, since
 * "one line for the caller" is the claim the API is making.
 *
 * The registry goes first and the position's own keys land on top, because a `$ref`'s siblings
 * describe *that position* and win over the target: `with.endpoint` keeps its own description
 * while taking `Endpoint`'s shape.
 *
 * `open` is a real requirement, not caution — `task` -> `taskList` -> `task` is a cycle in this
 * schema, and following it without a guard does not terminate.
 */
const REGISTRY = definitions();

function resolveDeep(shape: TypeShape, open: ReadonlySet<string> = new Set()): TypeShape {
  const name = shape.typeName;
  const merged: TypeShape = name === undefined ? shape : { ...REGISTRY[name], ...shape };

  if (name !== undefined && open.has(name)) return { ...merged, seenAlready: name } as TypeShape;
  const deeper = name === undefined ? open : new Set([...open, name]);
  const follow = (child: TypeShape): TypeShape => resolveDeep(child, deeper);

  return {
    ...merged,
    ...(merged.fields ? { fields: merged.fields.map((f) => ({ ...follow(f), key: f.key, required: f.required })) } : {}),
    ...(merged.variants ? { variants: merged.variants.map(follow) } : {}),
    ...(merged.items ? { items: follow(merged.items) } : {}),
    ...(merged.values ? { values: follow(merged.values) } : {}),
  } as TypeShape;
}

/** The resolved answer for a whole type — what a form is handed. */
function fullyResolved(name: string): TypeShape {
  return resolveDeep({ typeName: name });
}

/** A readable nesting of the resolved answer, since the JSON runs to thousands of lines. */
function tree(shape: TypeShape, indent = ''): string[] {
  const out: string[] = [];
  const seen = (shape as { seenAlready?: string }).seenAlready;
  if (seen !== undefined) return [`${indent}↩ ${seen} (already open on this path)`];

  for (const field of shape.fields ?? []) {
    const required = field.required ? '*' : ' ';
    const type = field.typeName ?? field.type ?? (field.anyValue ? 'any' : '?');
    const extra = field.const !== undefined ? ` = ${JSON.stringify(field.const)}` : '';
    out.push(`${indent} ${required} ${field.key} : ${type}${extra}`);
    out.push(...tree(field, `${indent}    `));
  }

  (shape.variants ?? []).forEach((variant, index) => {
    out.push(`${indent}   ${index}) ${variant.typeName ?? variant.type ?? 'branch'}`);
    out.push(...tree(variant, `${indent}    `));
  });

  if (shape.items !== undefined) {
    out.push(`${indent}   [] ${shape.items.typeName ?? shape.items.type ?? 'item'}`);
    out.push(...tree(shape.items, `${indent}    `));
  }
  if (shape.values !== undefined) {
    out.push(`${indent}   {} ${shape.values.typeName ?? shape.values.type ?? 'value'}`);
    out.push(...tree(shape.values, `${indent}    `));
  }
  return out;
}

/** What kind of thing this is, in the terms the API reports it. */
function kindOf(shape: TypeShape): string {
  if (shape.variants !== undefined) return `a choice of ${shape.variants.length}`;
  if (shape.keysAreFree) return 'a map (keys are the author\'s to choose)';
  if (shape.anyValue) return 'anything (the schema constrains nothing)';
  if (shape.fields !== undefined) return `an object of ${shape.fields.length} fields`;
  return shape.type ?? 'unknown';
}

/** A field on one line: what to call it, whether it is needed, and what may go in it. */
function line(field: TypeField): string {
  const required = field.required ? '*' : ' ';
  /* `typeName` is the whole point of the referenced design — the field names its type, and the
     shape of that type lives once in `definitions()` rather than being inlined here. */
  const type = field.typeName ?? field.type ?? (field.anyValue ? 'any' : '?');
  const notes: string[] = [];
  if (field.const !== undefined) notes.push(`const ${JSON.stringify(field.const)}`);
  if (field.enum !== undefined) notes.push(`enum ${field.enum.length}`);
  if (field.declared === false) notes.push('REQUIRED BUT NEVER DECLARED');

  return [
    ` ${required} ${field.key.padEnd(14)}`,
    type.padEnd(26),
    notes.length > 0 ? `(${notes.join(', ')}) ` : '',
    field.description ?? '',
  ].join('');
}

/*
 * Everything below runs inside a function so it can `return`.
 *
 * `process.exit()` was the obvious way to stop after printing, and it silently truncated `--full`
 * at exactly 65536 bytes: writes to a pipe are asynchronous, and exiting kills the process before
 * the buffer drains. Returning instead lets node flush on its own.
 */
function main(): void {
  if (typeName === undefined) {
    console.log(`\n${Object.keys(REGISTRY).length} types in the registry.`);
    console.log(`\n${taskTypeNames().length} task types — pass one as an argument:\n`);
    for (const name of taskTypeNames()) console.log(`  ${name}`);
    console.log('\n  ...or any other type name, e.g. CallHTTP, HTTPArguments, Endpoint.');
    console.log('  Add --tree for the whole thing resolved, --full for that as JSON.\n');
    return;
  }

  const definition = definitionOf(typeName);

  if (definition === undefined) {
    console.error(`\nNo type called ${typeName}.\n`);
    console.error(`Try one of: ${taskTypeNames().join(', ')}`);
    console.error('or run without an argument to list everything.\n');
    process.exitCode = 1;
    return;
  }

  if (asJson) {
    console.log(JSON.stringify({ ...definition, fields: fieldsOf(typeName) }, null, 2));
    return;
  }

  /* The whole thing, references followed — what a form is actually handed. Only the JSON goes to
     stdout, so it stays pipeable; the size note goes to stderr rather than corrupting it. */
  if (asFull) {
    const text = JSON.stringify(fullyResolved(typeName), null, 2);
    console.error(`${typeName}: ${(text.length / 1024).toFixed(1)} KB, ${text.split('\n').length} lines`);
    console.log(text);
    return;
  }

  if (asTree) {
    const resolved = fullyResolved(typeName);
    const rows = tree(resolved);
    console.log(`\n${typeName} — ${kindOf(resolved)}, fully resolved`);
    if (resolved.description !== undefined) console.log(resolved.description);
    console.log(`\n${rows.length} rows, * = required, ↩ = cycle stopped:\n`);
    console.log(rows.join('\n'));
    console.log();
    return;
  }

  console.log(`\n${definition.typeName} — ${kindOf(definition)}`);
  if (definition.description !== undefined) console.log(`${definition.description}`);

  /* A type that is a choice has no fields until a branch is picked, so `fieldsOf` correctly answers
     `[]`. Printing "no fields" without saying why reads as a bug. */
  if (definition.variants !== undefined) {
    console.log(`\nfieldsOf("${typeName}") is [] — pick a branch first:\n`);
    definition.variants.forEach((variant, index) => {
      console.log(`  ${index}. ${variant.typeName ?? kindOf(variant)}`);
    });
    const first = definition.variants[0]?.typeName ?? '<branch>';
    console.log(`\nThen: npx tsx scripts/try-schema-fields.ts ${first}\n`);
    return;
  }

  const fields = fieldsOf(typeName);
  console.log(`\nfieldsOf("${typeName}") — ${fields.length} fields, * = required:\n`);
  for (const field of fields) console.log(line(field));

  /* Every named type above is a key in `definitions()`, so a caller resolves it from there rather
     than asking for a deeper walk. Showing the next hop makes that concrete. */
  const referenced = [...new Set(fields.map((f) => f.typeName).filter((n): n is string => n !== undefined))];
  if (referenced.length > 0) {
    console.log(`\nThe types above live in definitions() — look any of them up the same way:`);
    console.log(`  npx tsx scripts/try-schema-fields.ts ${referenced[0]}`);
    console.log(`  ...or see the whole resolved answer: --tree\n`);
  }
}

main();
