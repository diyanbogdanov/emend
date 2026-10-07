import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePython } from '../src/python/parser.ts';

test('a Python source file parses into a tree whose root is a module', async () => {
  const tree = await parsePython('def f(x: int) -> str:\n    return str(x)\n');
  assert.equal(tree.rootNode.type, 'module');
  assert.equal(tree.rootNode.hasError, false);
});

test('the grammar node names this plan assumes are the ones the grammar actually uses', async () => {
  // This plan names `function_definition` and the `name`/`parameters`/`return_type`
  // fields from knowledge rather than from a parse. If the installed grammar
  // disagrees, every later task built on those names is wrong — so pin them here,
  // where the failure is one obvious test rather than a silently empty surface.
  const tree = await parsePython('def f(x: int) -> str:\n    return str(x)\n');
  const fn = tree.rootNode.namedChildren[0];
  assert.equal(fn?.type, 'function_definition');
  assert.equal(fn?.childForFieldName('name')?.text, 'f');
  assert.equal(fn?.childForFieldName('parameters')?.type, 'parameters');
  assert.equal(fn?.childForFieldName('return_type')?.text, 'str');
});

test('a class definition exposes its name and body', async () => {
  const tree = await parsePython('class Client:\n    def send(self) -> None: ...\n');
  const cls = tree.rootNode.namedChildren[0];
  assert.equal(cls?.type, 'class_definition');
  assert.equal(cls?.childForFieldName('name')?.text, 'Client');
  assert.equal(cls?.childForFieldName('body')?.type, 'block');
});
