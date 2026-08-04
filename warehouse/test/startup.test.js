// Do the names the app wires up on startup actually exist?
//
// This exists because they once did not. Removing a superseded receive path also
// removed submitMrpPlacement, which init() still wired to a form. The file
// parsed, every extracted-function test passed, and the app was dead on load:
// init() threw on the first missing name, so no zone rendered and the map came
// up empty. Parsing is not running, and testing extracted functions one at a
// time never touches the wiring between them.
//
// Static on purpose. Executing the whole app against a stub DOM hangs in code
// that has nothing to do with this check (QR generation, render loops that
// expect real geometry), so this reads the wiring directly instead — it is fast,
// deterministic, and catches exactly the failure above: a reference that
// survives while its definition is deleted.
//
//   node warehouse/test/startup.test.js

'use strict';

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const defined = (name) =>
  new RegExp('function\\s+' + name + '\\s*\\(').test(HTML) ||
  new RegExp('(?:const|let|var)\\s+' + name + '\\s*=').test(HTML);

let passed = 0, failed = 0;
const ok = (c, m, extra) => {
  if (c) { passed++; console.log('  PASS  ' + m); }
  else { failed++; console.log('  FAIL  ' + m + (extra ? '\n          ' + extra : '')); }
};

// 1. Handlers init() assigns — the exact shape that broke.
{
  const wired = [
    ...HTML.matchAll(/\$\('([A-Za-z0-9_]+)'\)\.(?:onsubmit|onclick|onchange|oninput)\s*=\s*([A-Za-z0-9_$]+)\s*[;\n]/g),
  ].map((w) => ({ id: w[1], fn: w[2] }));
  ok(wired.length > 15, 'the scan finds the startup wiring', 'found ' + wired.length);
  const bad = wired.filter((w) => !defined(w.fn));
  ok(bad.length === 0, 'every handler wired on startup has a definition',
     bad.map((b) => b.id + ' -> ' + b.fn + '()').join(', '));

  // The element it is wired to must exist too, or init() throws on the $() call.
  const noEl = wired.filter((w) => !new RegExp('id="' + w.id + '"').test(HTML));
  ok(noEl.length === 0, 'and every element it is wired to exists in the markup',
     noEl.map((b) => '#' + b.id).join(', '));
}

// 2. The render dispatch table — a deleted renderer means a zone silently stops
//    drawing, which is how "the map is empty" looks from the outside.
{
  const table = HTML.match(/\[\s*'Plant Storage'[\s\S]*?\]\s*\.forEach/);
  ok(!!table, 'the render dispatch table is found');
  if (table) {
    const renderers = [...table[0].matchAll(/\[\s*'[^']+'\s*,\s*([A-Za-z0-9_$]+)\s*\]/g)].map((r) => r[1]);
    ok(renderers.length > 10, 'and lists the zones', 'found ' + renderers.length);
    const missing = renderers.filter((r) => !defined(r));
    ok(missing.length === 0, 'every renderer in it has a definition', missing.join(', '));
    ['renderRack', 'renderBarrelStorage', 'renderEmptyToteOverflow', 'renderFloor',
     'renderStageGrid', 'renderBuildSlots', 'renderTransitSlots', 'renderInProcessZone']
      .forEach((r) => ok(renderers.includes(r), 'the map still draws ' + r));
  }
}

// 3. Handlers attached to rendered rows — the MRP catalog wires these after
//    drawing, so a deleted one breaks the window rather than the whole app.
{
  const delegated = [...HTML.matchAll(/\.forEach\(b=>b\.onclick=\(\)=>([A-Za-z0-9_$]+)\(/g)].map((d) => d[1]);
  ok(delegated.length > 0, 'row handlers are found', 'found ' + delegated.length);
  const bad = delegated.filter((d) => !defined(d));
  ok(bad.length === 0, 'every row handler has a definition', bad.join(', '));
}

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
