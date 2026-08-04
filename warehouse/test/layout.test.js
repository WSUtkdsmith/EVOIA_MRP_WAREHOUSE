// Do the map's zone boxes actually fit, and stay out of each other's way?
//
// This exists because they did not. The To/From and In Process boxes were placed
// against the coordinates in the base stylesheet, but later `!important` rules
// relocate the staging and rack regions — so the new boxes landed on top of
// them. And To/From was 466px wide while its own six-position grid needs 522px,
// so pallets spilled outside the box that was supposed to contain them.
//
// Effective geometry means the LAST rule for a selector wins, which is what the
// browser does and what reading only the first rule missed.
//
//   node warehouse/test/layout.test.js

'use strict';

const fs = require('fs');
const path = require('path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const CSS = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];

// Later rules override earlier ones, so fold them in document order.
function effective(selector) {
  const re = new RegExp('\\.' + selector + '\\{([^}]*)\\}', 'g');
  const out = {};
  let m;
  while ((m = re.exec(CSS))) {
    m[1].split(';').forEach((decl) => {
      const i = decl.indexOf(':');
      if (i < 0) return;
      out[decl.slice(0, i).trim()] = decl.slice(i + 1).trim();
    });
  }
  return out;
}
const px = (v) => parseInt(v, 10) || 0;

// A zone's drawn height comes from its grid, not from a guess. Assuming one row
// is what let a 3-row Build Slot (690-907) read as 100px tall and hide a real
// overlap. padding + title + rows*slot + gaps.
const SLOT_H = px((CSS.match(/--slot-h:\s*([^;]+);/) || [])[1]) || 54;
const GAP = px((CSS.match(/--slot-gap:\s*([^;]+);/) || [])[1]) || 6;
const TITLE_H = 23;

function gridRows(gridSelector) {
  const g = effective(gridSelector)['grid-template-rows'] || '';
  const m = g.match(/repeat\((\d+)/);
  if (m) return Number(m[1]);
  // No explicit rows: derive from how many cells the app puts in how many
  // columns, which is what the browser does implicitly.
  return null;
}

function zoneHeight(zoneSel, gridSel, cellCount) {
  const e = effective(zoneSel);
  if (px(e.height)) return px(e.height);
  const pad = px(e.padding) * 2;
  const cols = (() => {
    const g = effective(gridSel)['grid-template-columns'] || '';
    const m = g.match(/repeat\((\d+)/);
    return m ? Number(m[1]) : 1;
  })();
  const rows = gridRows(gridSel) || Math.ceil((cellCount || cols) / cols);
  return pad + TITLE_H + rows * SLOT_H + Math.max(0, rows - 1) * GAP;
}

function rect(selector, h) {
  const e = effective(selector);
  return { x: px(e.left), y: px(e.top), w: px(e.width), h: px(e.height) || h || 100 };
}

let passed = 0, failed = 0;
const ok = (c, m, extra) => {
  if (c) { passed++; console.log('  PASS  ' + m); }
  else { failed++; console.log('  FAIL  ' + m + (extra ? '\n          ' + extra : '')); }
};

const canvas = effective('mapCanvas');
const CW = px(canvas.width), CH = px(canvas.height);
ok(CW > 0 && CH > 0, 'the map canvas has a size', CW + 'x' + CH);

// Cell counts match what the app renders into each zone.
const zones = {
  stagingZone: rect('stagingZone'),
  plantStorageZone: rect('plantStorageZone'),
  buildZone: rect('buildZone', zoneHeight('buildZone', 'buildGrid', 6)),
  transitZone: rect('transitZone', zoneHeight('transitZone', 'transitGrid', 6)),
  // No grid: a title, a count and a note.
  inProcessZone: rect('inProcessZone', 90),
};

// The boxes must not sit on top of one another.
const names = Object.keys(zones);
const overlaps = [];
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = zones[names[i]], b = zones[names[j]];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
      overlaps.push(names[i] + ' x ' + names[j]);
    }
  }
}
ok(overlaps.length === 0, 'no zone box overlaps another', overlaps.join(', '));

// Every box must fit inside the canvas, or it is drawn where nobody can see it.
Object.entries(zones).forEach(([name, r]) => {
  ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= CW && r.y + r.h <= CH,
     name + ' fits inside the canvas',
     'x ' + r.x + '-' + (r.x + r.w) + ' y ' + r.y + '-' + (r.y + r.h) + ' vs ' + CW + 'x' + CH);
});

// A box must be wide enough for its own grid, or its contents spill out of it.
{
  const slotW = px((CSS.match(/--slot-w:\s*([^;]+);/) || [])[1]);
  const gap = px((CSS.match(/--slot-gap:\s*([^;]+);/) || [])[1]);
  ok(slotW > 0 && gap > 0, 'slot metrics are declared', slotW + '/' + gap);

  const gridCols = (selector) => {
    const g = effective(selector)['grid-template-columns'] || '';
    const m = g.match(/repeat\((\d+)/);
    return m ? Number(m[1]) : 0;
  };
  [['transitGrid', 'transitZone'], ['buildGrid', 'buildZone']].forEach(([gridSel, zoneSel]) => {
    const cols = gridCols(gridSel);
    const needed = cols * slotW + (cols - 1) * gap;
    const pad = px(effective(zoneSel).padding) * 2;
    const interior = zones[zoneSel].w - pad;
    ok(cols > 0, gridSel + ' declares its columns', String(cols));
    ok(needed <= interior,
       zoneSel + ' is wide enough for its ' + cols + ' slots — contents stay inside the box',
       'needs ' + needed + 'px, interior is ' + interior + 'px');
  });
}

// In Process is custody, not capacity: it must have no grid at all.
ok(!/\.inProcessGrid\{/.test(CSS), 'In Process declares no grid — there is nothing to slot');

console.log(`\n  ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
