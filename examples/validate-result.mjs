#!/usr/bin/env node
// Acceptance check for this public six-row example, not a general CSV validator.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

try {
  if (process.argv.length !== 3) throw new Error();
  const envelope = JSON.parse(await readFile(process.argv[2], 'utf8'));
  if (envelope.ok !== true || envelope.finish_reason !== 'stop'
      || typeof envelope.answer !== 'string' || !envelope.answer.trim()) throw new Error();
  const businessResult = JSON.parse(envelope.answer);
  const expected = JSON.parse(await readFile(new URL('./expected-rows.json', import.meta.url), 'utf8'));
  assert.deepEqual(businessResult, expected);
  process.stdout.write('Example accepted: all six rows and expected issues match.\n');
} catch {
  process.stderr.write('Example rejected: require current successful client JSON and exact expected rows/issues.\n');
  process.exitCode = 1;
}
