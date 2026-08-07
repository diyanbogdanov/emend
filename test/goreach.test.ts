import test from 'node:test';
import assert from 'node:assert/strict';
import { goInventory, goImports, goSymbolSites, symbolTargets } from '../src/goreach.ts';
import { compareVersions } from '../src/registry.ts';
import type { OsvRecord } from '../src/osv.ts';

// ---------------------------------------------------------------------------
// Inventory — the whole cost of a second ecosystem
// ---------------------------------------------------------------------------

const GO_SUM = `github.com/gin-gonic/gin v1.6.0 h1:abc=
github.com/gin-gonic/gin v1.6.0/go.mod h1:def=
github.com/stretchr/testify v1.8.4 h1:ghi=
github.com/stretchr/testify v1.8.4/go.mod h1:jkl=
`;

test('go.sum is the resolved set, so it is what gets screened', () => {
  // The same role package-lock.json plays: what is actually built against,
  // rather than the ranges go.mod declares.
  const found = goInventory(GO_SUM, '');
  assert.deepEqual(found, [
    { name: 'github.com/gin-gonic/gin', ecosystem: 'Go', version: 'v1.6.0' },
    { name: 'github.com/stretchr/testify', ecosystem: 'Go', version: 'v1.8.4' },
  ]);
});

test('the /go.mod hash lines are not a second copy of the module', () => {
  // Every module appears twice in go.sum — once for its content and once for its
  // go.mod. Counting both doubles every query and every finding.
  assert.equal(goInventory(GO_SUM, '').length, 2);
});

test('go.mod answers when there is no go.sum', () => {
  const mod = `module example.com/app

go 1.22

require (
	github.com/gin-gonic/gin v1.6.0
	github.com/spf13/cobra v1.8.0 // indirect
)
`;
  const found = goInventory('', mod);
  assert.deepEqual(
    found.map((p) => `${p.name}@${p.version}`),
    ['github.com/gin-gonic/gin@v1.6.0', 'github.com/spf13/cobra@v1.8.0'],
  );
});

test('a single-line require is read too', () => {
  const found = goInventory('', 'module x\n\nrequire github.com/pkg/errors v0.9.1\n');
  assert.deepEqual(found.map((p) => p.name), ['github.com/pkg/errors']);
});

test('no manifest at all yields nothing', () => {
  assert.deepEqual(goInventory('', ''), []);
});

// ---------------------------------------------------------------------------
// Which symbols an advisory names
// ---------------------------------------------------------------------------

const RECORD: OsvRecord = {
  id: 'GO-2023-1737',
  affected: [
    {
      package: { name: 'github.com/gin-gonic/gin', ecosystem: 'Go' },
      ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.9.1' }] }],
      ecosystem_specific: {
        imports: [{ path: 'github.com/gin-gonic/gin', symbols: ['Context.FileAttachment'] }],
      },
    },
  ],
};

test('the affected symbols are read from the record that carries them', () => {
  // Measured: GHSA records for Go carry no `ecosystem_specific`; the GO-xxxx
  // record they alias does. This is the data govulncheck runs on.
  assert.deepEqual(symbolTargets(RECORD, 'github.com/gin-gonic/gin'), [
    { path: 'github.com/gin-gonic/gin', symbols: ['Context.FileAttachment'] },
  ]);
});

test('a record with no symbol data names none, rather than guessing', () => {
  assert.deepEqual(symbolTargets({ id: 'GHSA-x', affected: [] }, 'github.com/x'), []);
});

// ---------------------------------------------------------------------------
// Finding them in Go source
// ---------------------------------------------------------------------------

const SOURCE = `package main

import (
	"fmt"
	gin "github.com/gin-gonic/gin"
	"github.com/spf13/cobra"
)

func main() {
	r := gin.Default()
	r.GET("/f", func(c *gin.Context) {
		c.FileAttachment("./x.txt", "x.txt")
	})
	fmt.Println(cobra.Command{})
}
`;

test('imports are read with their aliases, since the alias is what the code uses', () => {
  const imports = goImports(SOURCE);
  assert.equal(imports.get('gin'), 'github.com/gin-gonic/gin');
  // Unaliased imports are referred to by their last path element.
  assert.equal(imports.get('cobra'), 'github.com/spf13/cobra');
  assert.equal(imports.get('fmt'), 'fmt');
});

test('a method the advisory names is located where it is called', () => {
  const sites = goSymbolSites('main.go', SOURCE, {
    path: 'github.com/gin-gonic/gin',
    symbols: ['Context.FileAttachment'],
  });
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.line, 12);
  assert.match(sites[0]?.text ?? '', /FileAttachment/);
});

test('a package-level function is matched through its import alias', () => {
  const sites = goSymbolSites('main.go', SOURCE, {
    path: 'github.com/gin-gonic/gin',
    symbols: ['Default'],
  });
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.line, 10);
});

test('a file that never imports the module cannot reach its symbols', () => {
  // The strong negative. Without the import there is no path to the symbol at
  // all, whatever names happen to appear in the file.
  const other = 'package main\n\nfunc main() { x.FileAttachment("a", "b") }\n';
  assert.deepEqual(
    goSymbolSites('main.go', other, {
      path: 'github.com/gin-gonic/gin',
      symbols: ['Context.FileAttachment'],
    }),
    [],
  );
});

test('a symbol the advisory does not name is not reported', () => {
  const sites = goSymbolSites('main.go', SOURCE, {
    path: 'github.com/gin-gonic/gin',
    symbols: ['Context.SaveUploadedFile'],
  });
  assert.deepEqual(sites, []);
});

// ---------------------------------------------------------------------------
// The version prefix Go writes and npm does not
// ---------------------------------------------------------------------------

test('a leading v does not make every major version zero', () => {
  // `parseInt('v1')` is NaN, which fell through to 0 — so `v2.0.0` and `v1.0.0`
  // compared equal, and every Go range check was decided by the minor version
  // alone. It was right by luck on the first pair it met.
  assert.ok(compareVersions('v2.0.0', 'v1.0.0') > 0);
  assert.ok(compareVersions('v1.6.0', 'v1.9.1') < 0);
  assert.equal(compareVersions('v1.6.0', '1.6.0'), 0);
  assert.ok(compareVersions('v18', 'v22') < 0);
});
