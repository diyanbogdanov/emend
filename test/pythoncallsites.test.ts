import test from 'node:test';
import assert from 'node:assert/strict';
import { resolverFor, resolverForEcosystem } from '../src/callsites.ts';
import { pythonSites } from '../src/python/callsites.ts';

test('Python files are claimed, and PyPI is claimed by ecosystem', async () => {
  assert.equal(resolverFor('app/main.py')?.id, 'python');
  assert.equal(resolverFor('app/main.pyi')?.id, 'python');
  // `capabilitiesFor` asks by ecosystem, not by file — a resolver that only
  // implements `handles(file)` reports `callSites: false` while working.
  assert.equal(resolverForEcosystem('PyPI')?.id, 'python');
  assert.equal(resolverFor('src/lib.rs'), undefined);
});

test('an import is the precondition: no import, no site', async () => {
  // The negative is the strong half. Without the import there is no path to the
  // symbol, whatever names appear in the file.
  assert.deepEqual(await pythonSites('app.py', 'x = send(1)\n', 'requests', ['send']), []);
});

test('a from-import binds the name it introduces', async () => {
  const sites = await pythonSites(
    'app.py', 'from requests import send\n\nsend("https://x")\n', 'requests', ['send'],
  );
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.line, 3);
});

test('an aliased module import is followed through its alias', async () => {
  const sites = await pythonSites(
    'app.py', 'import requests as r\n\nr.send("https://x")\n', 'requests', ['send'],
  );
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.line, 3);
});

test('a method name matches only in a file that imports the module', async () => {
  // Resolving the receiver of `c.close()` needs a type checker Python does not
  // have here. So a match in an importing file is a strong lead and not proof.
  const importing = await pythonSites(
    'app.py',
    'import requests\n\nc = requests.Session()\nc.close()\n',
    'requests',
    ['Session.close'],
  );
  assert.equal(importing.length, 1);

  assert.deepEqual(
    await pythonSites('app.py', 'c.close()\n', 'requests', ['Session.close']),
    [],
  );
});
