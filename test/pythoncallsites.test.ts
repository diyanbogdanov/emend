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

// The five tests above all import the flat, top-level name (`from werkzeug
// import Headers`, `import werkzeug`). Measured against real Flask, that is
// not how a real repository imports: Flask's own source imports `werkzeug`
// 47 times, and every one of them is a submodule form (`from
// werkzeug.datastructures import Headers`, `from werkzeug.exceptions import
// HTTPException`, ...). Before the fix these six cases found 0 sites, not
// because the tool looked and found nothing, but because the resolver only
// recognised the package's own name and never looked past the first dot —
// silently degrading "fully examined" into "found nothing to examine".

test('a submodule from-import binds the name it introduces, same as a flat one', async () => {
  const sites = await pythonSites(
    'app.py', 'from werkzeug.datastructures import Headers\n\nHeaders()\n', 'werkzeug', ['Headers'],
  );
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.line, 3);
});

test('an aliased submodule from-import is followed through its alias', async () => {
  const sites = await pythonSites(
    'app.py', 'from werkzeug.datastructures import Headers as H\n\nH()\n', 'werkzeug', ['Headers'],
  );
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.line, 3);
});

test('an unaliased submodule import is reached by its literal dotted path', async () => {
  // `import werkzeug.datastructures` binds only the top-level name
  // `werkzeug` -- Python has no name bound to the submodule itself here -- so
  // the receiver of the call is a two-level attribute chain, not a single
  // identifier. The symbol is reached only by spelling out the whole chain
  // exactly as imported.
  const sites = await pythonSites(
    'app.py',
    'import werkzeug.datastructures\n\nwerkzeug.datastructures.Headers()\n',
    'werkzeug',
    ['Headers'],
  );
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.line, 3);
});

test('an aliased submodule import is followed through its alias', async () => {
  const sites = await pythonSites(
    'app.py', 'import werkzeug.datastructures as ds\n\nds.Headers()\n', 'werkzeug', ['Headers'],
  );
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.line, 3);
});

test('submodule matching is by path segment, not by string prefix', async () => {
  // The negative that matters: a naive `modulePath.startsWith(pkg)` check
  // would wrongly claim `requests_toolbelt` as part of `requests`, reporting
  // a call site in a package this repository never imported. Matching on
  // whole path segments (`pkg` itself, or `pkg` followed by a literal `.`)
  // rejects it.
  assert.deepEqual(
    await pythonSites('app.py', 'from requests_toolbelt import x\n\nx()\n', 'requests', ['x']),
    [],
  );
});

test('a submodule-imported method match still requires the import', async () => {
  // Same evidential position as the flat-import method test above, just
  // through a submodule binding: a method-name match is a lead gated on the
  // file importing the module at all, never proof by itself.
  const importing = await pythonSites(
    'app.py',
    'from werkzeug.datastructures import Headers\n\nh = Headers()\nh.add("x")\n',
    'werkzeug',
    ['Headers.add'],
  );
  assert.equal(importing.length, 1);

  assert.deepEqual(
    await pythonSites('app.py', 'h = Headers()\nh.add("x")\n', 'werkzeug', ['Headers.add']),
    [],
  );
});
