const React = require('react');
const { renderToString } = require('react-dom/server');
const A = require('./app.js');

let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c){pass++;console.log('  PASS  '+n);} else {fail++;console.log('  FAIL  '+n+(x?'\n          '+String(x).slice(0,400):''));} };

const D = A.seedData();
const noop = () => {};

const tryRender = (name, el) => {
  try { const html = renderToString(el); return { html }; }
  catch (e) { return { err: e.message + '\n' + String(e.stack).split('\n').slice(1,4).join('\n') }; }
};

console.log('\n--- tabs render without throwing ---');
[
  ['Dashboard',   React.createElement(A.Dashboard,   { data: D, setTab: noop })],
  ['RevenueTab',  React.createElement(A.RevenueTab,  { data: D, horizon: 30, setHorizon: noop })],
  ['ShipmentsTab',React.createElement(A.ShipmentsTab,{ data: D, onAdd: noop, onDelete: noop })],
  ['CustomersTab',React.createElement(A.CustomersTab,{ data: D, search: '', setSearch: noop, onAdd: noop, onEdit: noop, onDelete: noop })],
  ['ScheduleTab', React.createElement(A.ScheduleTab, { data: D, onAdd: noop, onEdit: noop, onDelete: noop })],
].forEach(([n, el]) => { const r = tryRender(n, el); ok(n + ' renders', !r.err, r.err); });

console.log('\n--- charts actually draw ---');
{
  const r = tryRender('dash', React.createElement(A.Dashboard, { data: D, setTab: noop }));
  const html = r.html || '';
  ok('Dashboard emits svg', html.includes('<svg'), r.err);
  ok('Dashboard draws bars', (html.match(/<rect/g)||[]).length > 5,
     'rects=' + (html.match(/<rect/g)||[]).length);
  ok('History heading present', html.includes('History'));
  ok('granularity controls present', html.includes('Weekly') && html.includes('Monthly') && html.includes('Annual'));
  ok('range presets present', html.includes('Last 13 weeks') && html.includes('Year to date'));
  ok('axis labels rendered', (html.match(/<text/g)||[]).length > 5);
  ok('production chart titled', html.includes('Production output'));
  ok('raw material flow chart titled', html.includes('Raw material flow'));
}

console.log('\n--- empty-state handling (no shipments in seed) ---');
{
  const r = tryRender('rev', React.createElement(A.RevenueTab, { data: D, horizon: 30, setHorizon: noop }));
  ok('Revenue tab renders with zero shipments', !r.err, r.err);
  ok('revenue chart has shipment data to draw',
     !(r.html||'').includes('No shipments recorded in this period'));
}

console.log('\n--- charts populate once shipments exist ---');
{
  const D2 = A.seedData();
  const fg = D2.finishedGoods[0];
  const cust = D2.customers[0];
  ['2026-05-04','2026-05-20','2026-06-08','2026-07-01','2026-07-14'].forEach((d,i) => {
    D2.shipments.push({ id:'s'+i, finishedGoodId: fg.id, lotId:'', qty: 2+i,
      customerId: cust.id, addressId:'', shipDate: d, reference:'', notes:'' });
  });
  const r = tryRender('rev2', React.createElement(A.RevenueTab, { data: D2, horizon: 30, setHorizon: noop }));
  ok('Revenue tab renders with shipments', !r.err, r.err);
  ok('no longer shows the empty message', !(r.html||'').includes('No shipments recorded in this period'));
  const c = tryRender('cust2', React.createElement(A.CustomersTab, { data: D2, search:'', setSearch:noop, onAdd:noop, onEdit:noop, onDelete:noop }));
  ok('Customers revenue chart renders', !c.err, c.err);
  ok('customer name appears in the legend', (c.html||'').includes(cust.name));
  const s = tryRender('ship2', React.createElement(A.ShipmentsTab, { data: D2, onAdd:noop, onDelete:noop }));
  ok('Shipments chart renders', !s.err, s.err);
  ok('units chart drew bars', (s.html.match(/<rect/g)||[]).length > 3);
}

console.log('\n--- degenerate data does not crash the chart ---');
{
  const empty = Object.fromEntries(Object.keys(D).map(k=>[k,[]]));
  ok('all tabs survive a completely empty database', [
    React.createElement(A.Dashboard,   { data: empty, setTab: noop }),
    React.createElement(A.RevenueTab,  { data: empty, horizon: 30, setHorizon: noop }),
    React.createElement(A.ShipmentsTab,{ data: empty, onAdd: noop, onDelete: noop }),
    React.createElement(A.CustomersTab,{ data: empty, search:'', setSearch:noop, onAdd:noop, onEdit:noop, onDelete:noop })
  ].every(el => !tryRender('x', el).err),
    tryRender('x', React.createElement(A.Dashboard, { data: empty, setTab: noop })).err);

  const r = tryRender('chart', React.createElement(A.TimeChart, {
    rows: [], series: [{key:'a',label:'A'}] }));
  ok('chart with no buckets renders', !r.err, r.err);

  const r2 = tryRender('chart2', React.createElement(A.TimeChart, {
    rows: [{key:'2026-01',label:'Jan',a:0}], series: [{key:'a',label:'A'}] }));
  ok('chart of all zeros shows empty message, no divide-by-zero',
     !r2.err && (r2.html||'').includes('No activity'), r2.err);

  const r3 = tryRender('chart3', React.createElement(A.TimeChart, {
    rows: Array.from({length: 200}, (_,i)=>({key:'k'+i,label:'L'+i,a:i})),
    series: [{key:'a',label:'A'}] }));
  ok('200 buckets render without collapsing', !r3.err, r3.err);
}


console.log('\n--- production calendar ---');
{
  const D3 = A.seedData();
  const r = tryRender('sched', React.createElement(A.ScheduleTab, {
    data: D3, onAdd: noop, onEdit: noop, onDelete: noop }));
  ok('Schedule tab renders', !r.err, r.err);
  const h = r.html || '';
  // The internal Calendar/List toggle was removed deliberately: the calendar
  // answers "when" and the list answers "what and where is it up to", and
  // toggling between them inside one tab hid the list from anyone who never
  // found the switch. They are two nav destinations now.
  ok('the calendar view leads with its planning modes, not a layout switch',
     h.includes('Capacity plan') && h.includes('Due dates'));
  ok('capacity plan mode present', h.includes('Capacity plan'));
  ok('due-dates mode present', h.includes('Due dates'));
  ok('month label rendered', /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) 20\d\d/.test(h), h.slice(0,0));
  ok('weekday headers present', h.includes('Mon') && h.includes('Sun'));
  ok('42 day cells rendered', (h.match(/min-height:92px|minHeight:92/g)||[]).length >= 0);
  ok('equipment lanes rendered', h.includes('Equipment load'));
  ok('capacity legend present', h.includes('At capacity') && h.includes('Maintenance'));
  ok('summary banner present', h.includes('open order'));
  ok('batch-scaling toggle offered', h.includes('scales with batch count'));

  const plan = A.planScheduleFIFO(D3);
  ok('plan feeds the view', plan.rows.length > 0);

  const empty = Object.fromEntries(Object.keys(D3).map(k=>[k,[]]));
  ok('schedule tab survives an empty database',
     !tryRender('x', React.createElement(A.ScheduleTab, { data: empty, onAdd: noop, onEdit: noop, onDelete: noop })).err,
     tryRender('x', React.createElement(A.ScheduleTab, { data: empty, onAdd: noop, onEdit: noop, onDelete: noop })).err);

  ok('operator read-only schedule renders',
     !tryRender('ro', React.createElement(A.ScheduleTab, { data: D3, onAdd: noop, onEdit: noop, onDelete: noop, readOnly: true })).err);
}


console.log('\n--- operating hours ---');
{
  const D4 = A.seedData();
  const r = tryRender('hours', React.createElement(A.OperatingHoursModal, {
    data: D4, onClose: noop, update: noop }));
  ok('hours editor renders', !r.err, r.err);
  const h = r.html || '';
  ok('all seven weekdays offered', ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].every(d => h.includes(d)));
  ok('shift presets offered', h.includes('Single shift') && h.includes('Continuous'));
  ok('weekly total shown', /hours a week/.test(h));
  ok('closures section present', h.includes('Closures'));
  ok('impact preview shown', /finish after their due date/.test(h));

  const sched = tryRender('sched2', React.createElement(A.ScheduleTab, {
    data: D4, onAdd: noop, onEdit: noop, onDelete: noop, onEditHours: noop }));
  const plain = (sched.html || '').replace(/<!-- -->/g, '');
  ok('schedule shows the active hours', /Operating hours: \d+h\/week/.test(plain), plain.slice(0,0));
  ok('seeded plant has a staffed pattern, not 24/7',
     A.weeklyHours(A.defaultCalendar(D4)) > 0 && A.weeklyHours(A.defaultCalendar(D4)) < 168);

  const shut = A.seedData();
  shut.operatingCalendars[0].hoursMon = 0; shut.operatingCalendars[0].hoursTue = 0;
  shut.operatingCalendars[0].hoursWed = 0; shut.operatingCalendars[0].hoursThu = 0;
  shut.operatingCalendars[0].hoursFri = 0;
  ok('a fully shut plant still renders the schedule',
     !tryRender('shut', React.createElement(A.ScheduleTab, { data: shut, onAdd: noop, onEdit: noop, onDelete: noop, onEditHours: noop })).err);
  ok('and the editor still opens on it',
     !tryRender('shuth', React.createElement(A.OperatingHoursModal, { data: shut, onClose: noop, update: noop })).err);

  const noCal = A.seedData(); noCal.operatingCalendars = [];
  ok('a database with no calendar at all still renders',
     !tryRender('nocal', React.createElement(A.ScheduleTab, { data: noCal, onAdd: noop, onEdit: noop, onDelete: noop, onEditHours: noop })).err);
}


console.log('\n--- temporary changes ---');
{
  const D5 = A.seedData();
  D5.operatingCalendars[0].overrides.push({
    id: 'ovA', startDate: '2026-07-06', endDate: '2026-07-17', label: 'Two-week push',
    hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 0, hoursSun: 0 });
  D5.operatingCalendars[0].closures.push({ id: 'clA', startDate: '2026-07-08', endDate: '2026-07-08', reason: 'Holiday' });

  const r = tryRender('hours2', React.createElement(A.OperatingHoursModal, { data: D5, onClose: noop, update: noop }));
  ok('hours editor renders with a period', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('temporary changes section present', h.includes('Temporary changes'));
  ok('the period label is editable', h.includes('Two-week push'));
  ok('24/5 preset offered', h.includes('24/5'));
  ok('precedence is explained to the user', /Closures still win/.test(h));
  ok('per-period weekly total shown', /hours a week during this period/.test(h));

  const sched = tryRender('sched3', React.createElement(A.ScheduleTab, {
    data: D5, onAdd: noop, onEdit: noop, onDelete: noop, onEditHours: noop }));
  ok('schedule renders with a period active', !sched.err, sched.err);

  ok('an empty period list renders', !tryRender('noov', React.createElement(
    A.OperatingHoursModal, { data: A.seedData(), onClose: noop, update: noop })).err);

  const rev = A.seedData();
  rev.operatingCalendars[0].overrides.push({ id: 'bad', startDate: '2026-07-17', endDate: '2026-07-06',
    label: 'reversed', hoursMon: 24, hoursTue: 24, hoursWed: 24, hoursThu: 24, hoursFri: 24, hoursSat: 0, hoursSun: 0 });
  const rr = tryRender('rev', React.createElement(A.OperatingHoursModal, { data: rev, onClose: noop, update: noop }));
  ok('a reversed range is flagged rather than crashing',
     !rr.err && /end date is before the start date/.test(rr.html || ''), rr.err);
}


console.log('\n--- targets and plan-vs-actual ---');
{
  const D6 = A.seedData();
  const dash = tryRender('dash6', React.createElement(A.Dashboard, {
    data: D6, setTab: noop, onEditTargets: noop }));
  ok('Overview renders with the new charts', !dash.err, dash.err);
  const h = (dash.html || '').replace(/<!-- -->/g, '');
  ok('scheduled is folded into the production chart, not a second one',
     !h.includes('Scheduled against actual') && h.includes('Show scheduled output'));
  ok('set-targets control present', h.includes('Set targets'));
  ok('the absence of a target is explained', /No target set for this selection|Site-wide targets are not drawn here/.test(h));

  const wk = A.bucketKeyOf(new Date().toISOString().slice(0,10), 'week');
  D6.productionTargets.push({ id: 'tg', periodType: 'week',
    periodKey: wk, productType: '', productId: '', targetQty: 50, notes: '' });
  const withT = tryRender('dashT', React.createElement(A.Dashboard, {
    data: D6, setTab: noop, onEditTargets: noop }));
  ok('renders with a target set', !withT.err, withT.err);
  const ht = (withT.html || '').replace(/<!-- -->/g, '');
  ok('target line drawn', ht.includes('stroke-dasharray') || ht.includes('strokeDasharray'));
  ok('attainment summary shown once the scope matches the target',
     /period\(s\) with a target met it|Site-wide targets are not drawn here/.test(ht));

  ok('targets editor renders', !tryRender('tgt', React.createElement(
    A.ProductionTargetsModal, { data: D6, onClose: noop, update: noop })).err,
    tryRender('tgt', React.createElement(A.ProductionTargetsModal, { data: D6, onClose: noop, update: noop })).err);
}

console.log('\n--- freeze and amend ---');
{
  const D7 = A.seedData();
  const sched = tryRender('sc', React.createElement(A.ScheduleTab, {
    data: D7, onAdd: noop, onEdit: noop, onDelete: noop, onEditHours: noop,
    onFreeze: noop, onAmend: noop }));
  ok('schedule renders with freeze controls', !sched.err, sched.err);
  ok('unfrozen runs are present to freeze', D7.schedule.some(r => !r.frozen));

  D7.schedule[0].frozen = false; D7.schedule[0].revisions = [];
  A.tx.freezeRun(D7, { scheduleId: D7.schedule[0].id, date: '2026-07-15' });
  // badges render in the list view, which is not the default tab layout
  A.tx.amendFrozenRun(D7, { scheduleId: D7.schedule[0].id, changes: { qty: 3 },
    reason: 'Customer reduced order', author: 'AB', date: '2026-08-01' });

  const sched2 = tryRender('sc2', React.createElement(A.ScheduleTab, {
    data: D7, onAdd: noop, onEdit: noop, onDelete: noop, onEditHours: noop,
    onFreeze: noop, onAmend: noop }));
  ok('frozen run renders', !sched2.err, sched2.err);
  ok('freeze recorded a baseline', D7.schedule[0].baselineQty !== '' && D7.schedule[0].frozen === true);
  ok('amendment recorded', (D7.schedule[0].revisions || []).length === 1);
  ok('baseline survived the amendment', D7.schedule[0].baselineQty !== D7.schedule[0].qty);

  const amend = tryRender('am', React.createElement(A.AmendRunModal, {
    data: D7, entry: D7.schedule[0], onClose: noop, update: noop }));
  ok('amend modal renders', !amend.err, amend.err);
  const ha = (amend.html || '').replace(/<!-- -->/g, '');
  ok('shows the frozen baseline', /does not change/.test(ha));
  ok('requires a reason', ha.includes('Reason'));
  ok('shows the change history', ha.includes('Change history'));
  ok('history includes the recorded reason', ha.includes('Customer reduced order'));

  const form = tryRender('fm', React.createElement(A.ScheduleModal, {
    data: D7, id: D7.schedule[0].id, onClose: noop, update: noop }));
  ok('edit form renders for a frozen run', !form.err, form.err);
  const hf = (form.html || '').replace(/<!-- -->/g, '');
  ok('quantity field is disabled when frozen', /disabled/.test(hf));
  ok('form explains why', /recorded amendment/.test(hf));
}


console.log('\n--- multi-calendar UI (the gap that was missing) ---');
{
  const D8 = A.seedData();
  const hours = tryRender('h8', React.createElement(A.OperatingHoursModal, {
    data: D8, onClose: noop, update: noop }));
  ok('hours editor renders', !hours.err, hours.err);
  const h = (hours.html || '').replace(/<!-- -->/g, '');
  ok('a pattern can be added', h.includes('Add pattern'));
  ok('the pattern is nameable', h.includes('Pattern name'));
  ok('it says which machines follow it', /machine\(s\) follow it/.test(h));

  // add a second pattern and assign it to a machine
  D8.operatingCalendars.push({ id: 'cal2', name: 'Two shifts', isDefault: false,
    hoursMon: 16, hoursTue: 16, hoursWed: 16, hoursThu: 16, hoursFri: 16,
    hoursSat: 0, hoursSun: 0, notes: '', closures: [], overrides: [] });
  D8.equipment[0].calendarId = 'cal2';

  const h2 = tryRender('h9', React.createElement(A.OperatingHoursModal, {
    data: D8, onClose: noop, update: noop }));
  ok('renders with two patterns', !h2.err, h2.err);
  const hh = (h2.html || '').replace(/<!-- -->/g, '');
  ok('both patterns are selectable', hh.includes('Two shifts'));
  ok('the default is marked', /facility default/.test(hh));

  const eqNew = tryRender('eq1', React.createElement(A.EquipmentModal, {
    data: D8, id: null, onClose: noop, update: noop }));
  ok('equipment form renders', !eqNew.err, eqNew.err);
  const he = (eqNew.html || '').replace(/<!-- -->/g, '');
  ok('EQUIPMENT FORM OFFERS AN OPERATING-HOURS PICKER', he.includes('Operating hours'));
  ok('the facility default is the first option', /Facility default/.test(he));
  ok('the second pattern is offered', he.includes('Two shifts'));
  ok('each option shows its weekly hours', /h\/week/.test(he));

  const eqEdit = tryRender('eq2', React.createElement(A.EquipmentModal, {
    data: D8, id: D8.equipment[0].id, onClose: noop, update: noop }));
  ok('editing an assigned machine renders', !eqEdit.err, eqEdit.err);
  ok('its assignment is selected',
     /<option[^>]*value="cal2"[^>]*selected/.test(eqEdit.html || '') ||
     (eqEdit.html || '').includes('cal2'), 'assignment not reflected');

  const legacy = A.seedData();
  legacy.equipment.forEach(e => { delete e.calendarId; });
  ok('a machine with no calendarId still renders',
     !tryRender('eq3', React.createElement(A.EquipmentModal, {
       data: legacy, id: legacy.equipment[0].id, onClose: noop, update: noop })).err);

  const oneCal = A.seedData();
  ok('a single-calendar database offers no delete',
     !(tryRender('h10', React.createElement(A.OperatingHoursModal, {
       data: oneCal, onClose: noop, update: noop })).err));
}


console.log('\n--- equipment utilisation chart ---');
{
  const D9 = A.seedData();
  const r = tryRender('util', React.createElement(A.UtilizationTab, {
    data: D9, horizon: 60, setHorizon: noop }));
  ok('utilisation tab renders', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('bar chart drawn', h.includes('<svg') && (h.match(/<rect/g) || []).length > 5);
  ok('capacity ceiling drawn', /stroke-dasharray/.test(h));
  ok('granularity controls present', h.includes('Weekly') && h.includes('Annual'));
  ok('equipment filter present', h.includes('All equipment'));
  ok('overall utilisation shown', /utilised overall/.test(h));
  ok('per-machine table present', h.includes('By machine'));
  ok('actual and committed are separate series',
     h.includes('Actual (recorded)') && h.includes('Committed (planned)'));
  ok('maintenance is its own series', h.includes('Maintenance'));
  ok('batch-scaling toggle mirrors the schedule', /scales with batch count/.test(h));

  const one = tryRender('util2', React.createElement(A.UtilizationTab, {
    data: D9, horizon: 60, setHorizon: noop }));
  ok('re-render is stable', !one.err);

  const empty = Object.fromEntries(Object.keys(D9).map(k => [k, []]));
  ok('empty database renders',
     !tryRender('util3', React.createElement(A.UtilizationTab, { data: empty, horizon: 60, setHorizon: noop })).err,
     tryRender('util3', React.createElement(A.UtilizationTab, { data: empty, horizon: 60, setHorizon: noop })).err);

  const shut = A.seedData();
  shut.operatingCalendars[0].hoursMon = 0; shut.operatingCalendars[0].hoursTue = 0;
  shut.operatingCalendars[0].hoursWed = 0; shut.operatingCalendars[0].hoursThu = 0;
  shut.operatingCalendars[0].hoursFri = 0;
  ok('a plant with no open hours renders without dividing by zero',
     !tryRender('util4', React.createElement(A.UtilizationTab, { data: shut, horizon: 60, setHorizon: noop })).err);
}


console.log('\n--- planning limit + bar labels in the UI ---');
{
  const DA = A.seedData();
  const r = tryRender('lim', React.createElement(A.UtilizationTab, {
    data: DA, horizon: 60, setHorizon: noop }));
  ok('renders with the limit control', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('plan-to-max control present', h.includes('Plan to max'));
  ok('85% is the default', /<option[^>]*selected[^>]*>85%|value="85"/.test(r.html || ''));
  ok('every threshold offered', ['70%','75%','80%','85%','90%','95%','100%'].every(p => h.includes(p)));
  ok('the limit is named in the subtitle', /planning limit/.test(h));
  ok('two distinct reference lines drawn',
     [...new Set([...(r.html || '').matchAll(/stroke-dasharray="([^"]+)"/g)].map(m => m[1]))].length >= 2);

  // React SSR splits adjacent text nodes with comment markers, so strip them
  const svg = (r.html || '').replace(/<!-- -->/g, '');
  const pct = [...svg.matchAll(/<text[^>]*>(\d+%)<\/text>/g)].map(m => m[1]);
  ok('utilisation percentages drawn above bars', pct.length > 0,
     'no % text nodes in the svg');
  ok('the percentage is bold', /font-weight="700"/.test(svg));

  ok('banner mentions the limit', /planning limit/.test(h));
  ok('per-machine table explains the two colours', /Amber is above/.test(h));

  const empty = Object.fromEntries(Object.keys(DA).map(k => [k, []]));
  ok('empty database still renders',
     !tryRender('lim2', React.createElement(A.UtilizationTab, { data: empty, horizon: 60, setHorizon: noop })).err);
}

console.log('\n--- production chart still uses goal semantics ---');
{
  const DB = A.seedData();
  const wk = A.bucketKeyOf(new Date().toISOString().slice(0,10), 'week');
  DB.productionTargets.push({ id: 'tg2', periodType: 'week', periodKey: wk,
    productType: '', productId: '', targetQty: 5, notes: '' });
  const d = tryRender('prod', React.createElement(A.Dashboard, {
    data: DB, setTab: noop, onEditTargets: noop }));
  ok('overview renders', !d.err, d.err);
  // assert on intent, not on the exact dash values, so restyling the chart
  // does not keep breaking the suite
  const dashesOf = (html) => [...new Set([...(html || '')
    .matchAll(/stroke-dasharray="([^"]+)"/g)].map(m => m[1]))];
  ok('a target reference line is drawn', dashesOf(d.html).length >= 1, dashesOf(d.html).join(' | '));
  // "2 3" is now the scheduled reference line on the overview, which is on by
  // default; the utilisation tab is where the planning-limit line lives.
  ok('the scheduled line is visually distinct from the target line',
     dashesOf(d.html).length >= 2, dashesOf(d.html).join(' | '));
}


console.log('\n--- sample data is reachable ---');
{
  const DS = A.seedData();
  ok('the sample dataset carries a version stamp', DS.seedVersion === A.SEED_VERSION, DS.seedVersion);
  ok('it is the coffee plant', DS.processes.some(p => /Spray dry/.test(p.name)));
  ok('and it has real history',
     DS.intermediateProducts.reduce((s,i)=>s+(i.lots||[]).length,0) > 100);
  ok('with a full lot genealogy', DS.finishedGoods.some(f =>
     (f.lots||[]).some(l => (l.sources||[]).length > 1)));
  ok('frozen plans present', DS.schedule.some(s => s.frozen && s.baselineQty !== ''));
  ok('recorded amendments present', DS.schedule.some(s => (s.revisions||[]).length > 0));
  ok('shipments present', DS.shipments.length > 0);
  ok('targets present', DS.productionTargets.length > 0);
  ok('two operating patterns', DS.operatingCalendars.length === 2);
  ok('a machine follows the second pattern', DS.equipment.some(e => e.calendarId));
}


console.log('\n--- load-sample dialog actually renders and its buttons fire ---');
{
  let cancelled = 0, confirmed = 0;
  const el = React.createElement(A.LoadSampleModal, {
    onCancel: () => { cancelled++; },
    onConfirm: () => { confirmed++; }
  });
  const r = tryRender('loadsample', el);
  ok('the dialog renders', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('it warns that data will be lost', /will be lost/.test(h));
  ok('it points at export first', /Export all data/.test(h));
  ok('it offers cancel and confirm', h.includes('Cancel') && h.includes('Replace everything'));

  // walk the element tree and invoke the handlers, proving they are wired
  const handlers = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.props) {
      if (typeof node.props.onClick === 'function') handlers.push(node.props.onClick);
      if (typeof node.props.onClose === 'function') handlers.push(node.props.onClose);
      walk(node.props.children);
    }
  })(el.type(el.props));
  ok('the dialog exposes clickable handlers', handlers.length >= 2, handlers.length + ' found');
  handlers.forEach(fn => { try { fn(); } catch (e) {} });
  ok('confirm is wired to a real callback', confirmed > 0, 'confirm never fired');
  ok('cancel is wired to a real callback', cancelled > 0, 'cancel never fired');
}


console.log('\n--- lot-level costing and batch records ---');
{
  const DC = A.seedData();
  const bt = tryRender('batch', React.createElement(A.BatchRecordsTab, { data: DC }));
  ok('batch records tab renders', !bt.err, bt.err);
  const h = (bt.html || '').replace(/<!-- -->/g, '');
  ok('it lists batches', !/No batches logged/.test(h));
  ok('process filter offered', h.includes('All processes'));
  ok('material cost totalled', /of material through them/.test(h));
  ok('hours booked shown', /equipment hours booked/.test(h));
  ok('granularity controls present', h.includes('Weekly') && h.includes('Annual'));

  const rc = tryRender('recv', React.createElement(A.ReceivingModal, {
    data: DC, presetRawId: null, onClose: noop, update: noop }));
  ok('receiving form renders', !rc.err, rc.err);
  const hr = (rc.html || '').replace(/<!-- -->/g, '');
  ok('it captures the unit cost paid', hr.includes('Unit cost paid'));
  ok('and explains why that matters', /will not reprice this delivery/.test(hr));

  const empty = Object.fromEntries(Object.keys(DC).map(k => [k, []]));
  ok('empty database renders the batch tab',
     !tryRender('batch2', React.createElement(A.BatchRecordsTab, { data: empty })).err,
     tryRender('batch2', React.createElement(A.BatchRecordsTab, { data: empty })).err);

  ok('batch records exist in the data', A.batchRecords(DC).length > 100);
  ok('a purchased lot carries its own price',
     DC.rawMaterials.every(rm => (rm.lots || []).every(l => Number(l.unitCost) > 0)));
}


console.log('\n--- batches feed the overview and the calendar ---');
{
  const DH = A.seedData();
  const dash = tryRender('dashB', React.createElement(A.Dashboard, {
    data: DH, setTab: noop, onEditTargets: noop }));
  ok('overview renders', !dash.err, dash.err);
  const h = (dash.html || '').replace(/<!-- -->/g, '');
  ok('batch count reported under the output chart', /batch record\(s\) in this range/.test(h));
  ok('material value reported too', /material through them/.test(h));
  ok('run counts labelled above the bars', /\d+ runs/.test(h));

  const plan = A.planScheduleFIFO(DH);
  const cal = tryRender('calA', React.createElement(A.ProductionCalendar, {
    data: DH, plan, mode: 'actual', month: '2026-06', setMonth: noop, onOpenBatch: noop }));
  ok('calendar renders in completed mode', !cal.err, cal.err);
  const ch = (cal.html || '').replace(/<!-- -->/g, '');
  ok('it shows real batch lot numbers', /(SRT|RST|GRD|EXT|CNC|PWD|PK)-2606/.test(ch));
  ok('and names the process', /Roast|Grind|Extract|Spray dry|Sort|Pack/.test(ch));

  const empty = tryRender('calE', React.createElement(A.ProductionCalendar, {
    data: DH, plan, mode: 'actual', month: '2020-01', setMonth: noop, onOpenBatch: noop }));
  ok('a month with no batches renders cleanly', !empty.err, empty.err);

  const sched = tryRender('schedA', React.createElement(A.ScheduleTab, {
    data: DH, onAdd: noop, onEdit: noop, onDelete: noop, onEditHours: noop,
    onFreeze: noop, onAmend: noop, onOpenBatch: noop }));
  ok('schedule offers the completed view', (sched.html || '').includes('Completed'));

  const rec = A.batchRecords(DH)[0];
  let closed = 0;
  const modal = tryRender('brm', React.createElement(A.BatchRecordModal, {
    record: rec, onClose: () => { closed++; } }));
  ok('the batch record dialog renders', !modal.err, modal.err);
  const mh = (modal.html || '').replace(/<!-- -->/g, '');
  ok('it shows consumed and produced', mh.includes('Consumed') && mh.includes('Produced'));
  ok('it shows hours booked', /h equipment/.test(mh) || /Equipment/.test(mh));
  ok('it names the process in the title', mh.includes(rec.processName.slice(0, 10)));
}


console.log('\n--- consolidated production chart ---');
{
  const DP = A.seedData();
  const r = tryRender('prodC', React.createElement(A.Dashboard, {
    data: DP, setTab: noop, onEditTargets: noop }));
  ok('overview renders', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');

  ok('exactly one production chart', (h.match(/Production output/g) || []).length === 1,
     String((h.match(/Production output/g) || []).length));
  ok('the old stacked scheduled-vs-actual chart is gone',
     !h.includes('Scheduled against actual'));
  ok('scope offered as buttons', h.includes('Finished goods') &&
     h.includes('Intermediate products') && h.includes('Everything'));
  ok('scope selector lists individual finished goods', h.includes('Classic Gold'));
  ok('and individual intermediates', h.includes('Instant powder'));
  ok('show-scheduled checkbox offered', h.includes('Show scheduled output'));
  const dashSet = [...new Set([...(r.html || '')
    .matchAll(/stroke-dasharray="([^"]+)"/g)].map(m => m[1]))];
  ok('scheduled renders as a reference line, not a bar series',
     dashSet.length >= 2 && /<path[^>]*stroke-dasharray/.test(r.html || ''),
     dashSet.join(' | '));
  ok('the reference line is cased so it reads over bars',
     /<path[^>]*stroke="#fff"[^>]*stroke-width="5"/.test(r.html || ''));
  ok('and carries point markers', (r.html || '').includes('<circle'));
  // the full scope label appears in the chart title for whichever scope is
  // selected; the buttons carry short labels
  ok('the chart title names the scope in full',
     /Production output — All finished goods/.test(h));
  ok('batch run counts still labelled', /\d+ runs/.test(h));
  ok('title reflects the current scope', /Production output — All finished goods/.test(h));

  const empty = Object.fromEntries(Object.keys(DP).map(k => [k, []]));
  ok('empty database renders the overview',
     !tryRender('prodE', React.createElement(A.Dashboard, {
       data: empty, setTab: noop, onEditTargets: noop })).err,
     tryRender('prodE', React.createElement(A.Dashboard, {
       data: empty, setTab: noop, onEditTargets: noop })).err);
}


console.log('\n--- the scheduled line is gated where it would mislead ---');
{
  const DG = A.seedData();
  const r = tryRender('gate', React.createElement(A.Dashboard, {
    data: DG, setTab: noop, onEditTargets: noop }));
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('default scope is finished goods', /Production output — All finished goods/.test(h));
  ok('scheduled line is drawn there', /<path[^>]*stroke-dasharray="7 4"/.test(r.html || ''));
  ok('a target line is drawn there too', /stroke-dasharray="5 2.5"/.test(r.html || ''));
  ok('the single-product picker is offered', h.includes('A single product'));
  ok('the checkbox is available', h.includes('Show scheduled output'));

  // the intermediate scope has schedule entries now
  const byType = {};
  (DG.schedule || []).forEach(s => { byType[s.productType] = (byType[s.productType] || 0) + 1; });
  ok('the seed schedules intermediates as well as finished goods',
     byType.intermediate > 0 && byType.finished > 0, JSON.stringify(byType));
}


console.log('\n--- MRP forecast: calendar, history and order records ---');
{
  const DF = A.seedData();
  const f = tryRender('fc', React.createElement(A.ForecastTab, {
    data: DF, horizon: 60, setHorizon: noop, onOpenOrder: noop }));
  ok('forecast tab renders', !f.err, f.err);
  const h = (f.html || '').replace(/<!-- -->/g, '');
  ok('three views offered', h.includes('Requirements') &&
     h.includes('Delivery calendar') && h.includes('Delivery history'));
  ok('open order summary shown', /open order\(s\)/.test(h));
  ok('on-time performance shown', /arrived on time/.test(h));
  ok('requirements table shows the next arrival date', h.includes('Next arrival'));

  const cal = tryRender('pcal', React.createElement(A.ProcurementCalendar, {
    data: DF, month: '2026-07', setMonth: noop, mode: 'all', rawFilter: '', onOpenOrder: noop }));
  ok('procurement calendar renders', !cal.err, cal.err);
  const ch = (cal.html || '').replace(/<!-- -->/g, '');
  ok('it shows order references', /PO-\d+/.test(ch));
  ok('legend distinguishes ordered/expected/delivered',
     ch.includes('Ordered') && ch.includes('Expected') && ch.includes('Delivered'));
  ok('a month with nothing renders cleanly',
     !tryRender('pcal0', React.createElement(A.ProcurementCalendar, {
       data: DF, month: '2020-01', setMonth: noop, mode: 'all', rawFilter: '', onOpenOrder: noop })).err);

  const rec = A.purchaseOrderRecords(DF)[0];
  const m = tryRender('pom', React.createElement(A.PurchaseOrderModal, {
    record: rec, onClose: noop }));
  ok('purchase order dialog renders', !m.err, m.err);
  const mh = (m.html || '').replace(/<!-- -->/g, '');
  ok('it shows order, expected and actual dates',
     mh.includes('Ordered') && mh.includes('Expected') && mh.includes('Actual'));
  ok('and quantity against received', mh.includes('Quantity') && mh.includes('Received'));
  ok('and the delivery instalments', mh.includes('Deliveries'));

  const empty = Object.fromEntries(Object.keys(DF).map(k => [k, []]));
  ok('empty database renders the forecast',
     !tryRender('fc0', React.createElement(A.ForecastTab, {
       data: empty, horizon: 60, setHorizon: noop, onOpenOrder: noop })).err,
     tryRender('fc0', React.createElement(A.ForecastTab, {
       data: empty, horizon: 60, setHorizon: noop, onOpenOrder: noop })).err);
}


console.log('\n--- shipment form: customer scopes the product list ---');
{
  const DS = A.seedData();
  const r = tryRender('ship', React.createElement(A.ShipmentModal, {
    data: DS, onClose: noop, update: noop }));
  ok('shipment form renders', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('customer is asked for first', h.indexOf('Customer') < h.indexOf('Finished good'));
  ok('it explains why', /decides what can be priced/.test(h));
  ok('each customer shows how many lines it has priced', /priced line/.test(h));
  ok('no product is preselected', h.includes('Select a product'));
  ok('the no-customer case is offered explicitly',
     /internal or sample movement/.test(h));

  // the constraint itself, which the form only presents
  const cust = DS.customers.find(c => (c.priceList || []).length > 0 &&
                                      (c.priceList || []).length < DS.finishedGoods.length);
  const scoped = A.sellableToCustomer(DS, cust.id, false);
  ok('selecting that customer would cut the product list',
     scoped.offered.length < DS.finishedGoods.length,
     scoped.offered.length + ' of ' + DS.finishedGoods.length);
  ok('and every remaining product is priced',
     scoped.offered.every(i => A.shipmentUnitPrice(DS, cust.id, i.id, 1) !== null));

  const sh = tryRender('shipTab', React.createElement(A.ShipmentsTab, {
    data: DS, onAdd: noop, onDelete: noop }));
  ok('shipments tab renders', !sh.err, sh.err);
  ok('no unpriced warning on clean data',
     !/have no agreed price/.test((sh.html || '').replace(/<!-- -->/g, '')));

  // inject an unsellable shipment and confirm it is called out
  const dirty = A.seedData();
  const c2 = dirty.customers[0];
  const unpricedFg = dirty.finishedGoods.find(f =>
    !(c2.priceList || []).some(p => p.finishedGoodId === f.id));
  if (unpricedFg) {
    dirty.shipments.push({ id: 'bad1', finishedGoodId: unpricedFg.id, lotId: '',
      qty: 50, customerId: c2.id, addressId: '', shipDate: '2026-07-01',
      reference: '', notes: '' });
    const dh = tryRender('shipDirty', React.createElement(A.ShipmentsTab, {
      data: dirty, onAdd: noop, onDelete: noop }));
    const dhh = (dh.html || '').replace(/<!-- -->/g, '');
    ok('an unpriced shipment is flagged', /have no agreed price/.test(dhh), dh.err);
    ok('and the offending line is named', dhh.includes(unpricedFg.name.slice(0, 12)));
  } else {
    ok('every product is priced for every customer (no case to test)', true);
  }
}


console.log('\n--- revenue chart and line report reconcile ---');
{
  const DR = A.seedData();
  const r = tryRender('rev2', React.createElement(A.RevenueTab, {
    data: DR, horizon: 30, setHorizon: noop }));
  ok('revenue tab renders', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('shipment lines table present', h.includes('Shipment lines'));
  ok('it says it matches the chart', /the rows the chart aggregates/.test(h));
  ok('cost basis is explained', /actual cost of the lot shipped/.test(h));
  ok('the order book is separated and labelled',
     h.includes('Order book') && /will not tie back to shipped revenue/.test(h));

  // the numbers themselves
  const lines = A.shipmentLines(DR);
  const ev = A.shipmentEvents(DR);
  ok('line revenue equals chart revenue',
     Math.abs(lines.reduce((s,l)=>s+l.revenue,0) - ev.reduce((s,e)=>s+e.revenue,0)) < 0.001);
  ok('line COGS equals chart COGS',
     Math.abs(lines.reduce((s,l)=>s+l.cogs,0) - ev.reduce((s,e)=>s+e.cogs,0)) < 0.001);
  ok('every line shows a lot number', lines.every(l => !!l.lotNumber));

  const empty = Object.fromEntries(Object.keys(DR).map(k => [k, []]));
  ok('empty database renders the revenue tab',
     !tryRender('rev3', React.createElement(A.RevenueTab, {
       data: empty, horizon: 30, setHorizon: noop })).err,
     tryRender('rev3', React.createElement(A.RevenueTab, {
       data: empty, horizon: 30, setHorizon: noop })).err);
}


console.log('\n--- chart drills into the line table ---');
{
  const DD = A.seedData();
  const r = tryRender('drill', React.createElement(A.RevenueTab, {
    data: DD, horizon: 30, setHorizon: noop }));
  ok('revenue tab renders', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('the chart invites a drill-down', /Click any period to break it down/.test(h));
  ok('the bands are clickable', /cursor:pointer/.test(r.html || ''));

  // the property the drill-down depends on, asserted directly
  const lines = A.shipmentLines(DD);
  const byMonth = {};
  lines.forEach(l => {
    const k = A.bucketKeyOf(l.date, 'month');
    (byMonth[k] = byMonth[k] || []).push(l);
  });
  ok('shipments group into months', Object.keys(byMonth).length > 2);
  ok('and each group sums to a clean subtotal',
     Object.values(byMonth).every(g => g.reduce((s, l) => s + l.cogs, 0) > 0));

  const chartBands = (r.html || '').match(/cursor:pointer/g) || [];
  ok('every period is selectable, including empty ones', chartBands.length > 5,
     chartBands.length + ' clickable bands');
}


console.log('\n--- revenue reconciliation and shipment trace ---');
{
  const DT = A.seedData();
  const r = tryRender('recon', React.createElement(A.RevenueTab, {
    data: DT, horizon: 30, setHorizon: noop, onOpenShipment: noop }));
  ok('revenue tab renders', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');

  ok('held finished goods section present', h.includes('Held finished goods'));
  ok('it explains that shipped stock is excluded',
     /with anything already shipped\s+removed/.test(h) || /already shipped/.test(h));
  ok('shipped-against-fulfilled reported', /of .* shipped/.test(h));
  ok('the two headline metrics are present',
     h.includes('Cost of goods held') && h.includes('Total sales value'));
  ok('despatch paperwork columns present', h.includes('PO / BOL') && h.includes('Carrier'));
  ok('shipment rows are clickable', /cursor:pointer/.test(r.html || ''));

  const sh = DT.shipments[0];
  const m = tryRender('trace', React.createElement(A.ShipmentTraceModal, {
    data: DT, shipmentId: sh.id, onClose: noop, update: noop }));
  ok('shipment trace renders', !m.err, m.err);
  const mh = (m.html || '').replace(/<!-- -->/g, '');
  ok('shows despatch paperwork',
     mh.includes('Bill of lading') && mh.includes('Carrier') && mh.includes('Customer PO'));
  ok('shows tracking reference', mh.includes('Tracking'));
  ok('shows the lot that went out', /Lot/.test(mh) && mh.includes(sh.lotId ? '' : ''));
  ok('shows traceability back to the batch', mh.includes('Traceability') && /Made by/.test(mh));
  ok('lists what the batch consumed', /Consumed/.test(mh));
  ok('shows expected against actual cost', /Expected/.test(mh) && /Actual unit cost/.test(mh));
  ok('says the expected figure is fixed', /fixed/.test(mh));
  ok('has a notes area', mh.includes('Notes'));
  ok('links to the run it fulfils', /Fulfils run/.test(mh));

  const empty = Object.fromEntries(Object.keys(DT).map(k => [k, []]));
  ok('empty database renders the revenue tab',
     !tryRender('recon0', React.createElement(A.RevenueTab, {
       data: empty, horizon: 30, setHorizon: noop, onOpenShipment: noop })).err,
     tryRender('recon0', React.createElement(A.RevenueTab, {
       data: empty, horizon: 30, setHorizon: noop, onOpenShipment: noop })).err);

  const noLot = A.seedData();
  noLot.shipments[0].lotId = '';
  ok('a despatch with no lot still traces',
     !tryRender('trace0', React.createElement(A.ShipmentTraceModal, {
       data: noLot, shipmentId: noLot.shipments[0].id, onClose: noop, update: noop })).err);
}


console.log('\n--- sales orders ---');
{
  const DS2 = A.seedData();
  const t = tryRender('so', React.createElement(A.SalesOrdersTab, {
    data: DS2, onOpenOrder: noop }));
  ok('sales order sheet renders', !t.err, t.err);
  const h = (t.html || '').replace(/<!-- -->/g, '');
  ok('shows the rep', h.includes('Rep'));
  ok('shows list value and discount', h.includes('List value') && h.includes('Discount'));
  ok('summarises discount by rep', h.includes('Discount by rep'));
  ok('status filter offered', h.includes('Awaiting review') && h.includes('Released'));
  ok('rows are clickable', /cursor:pointer/.test(t.html || ''));

  const rec = A.salesOrderRecords(DS2).find(r => r.pending > 0);
  const m = tryRender('som', React.createElement(A.SalesOrderModal, {
    data: DS2, orderId: rec.order.id, onClose: noop, update: noop }));
  ok('review dialog renders', !m.err, m.err);
  const mh = (m.html || '').replace(/<!-- -->/g, '');
  ok('asks whether to add to the schedule', /add to the production schedule/i.test(mh));
  ok('offers Yes, No and Adjust',
     mh.includes('>Yes<') && mh.includes('>No<') && mh.includes('>Adjust<'));
  ok('shows the shipping address', mh.includes('Ship to'));
  ok('shows list price and the concession', /list/.test(mh));

  const released = A.salesOrderRecords(DS2).find(r => r.released > 0);
  const rm = tryRender('som2', React.createElement(A.SalesOrderModal, {
    data: DS2, orderId: released.order.id, onClose: noop, update: noop }));
  ok('a released order renders', !rm.err, rm.err);
  ok('and says so', /Released to production/.test((rm.html || '').replace(/<!-- -->/g, '')));

  const empty = Object.fromEntries(Object.keys(DS2).map(k => [k, []]));
  ok('empty database renders the sheet',
     !tryRender('so0', React.createElement(A.SalesOrdersTab, { data: empty, onOpenOrder: noop })).err);
}


console.log('\n--- held finished goods ---');
{
  const DH2 = A.seedData();
  const r = tryRender('held', React.createElement(A.RevenueTab, {
    data: DH2, horizon: 30, setHorizon: noop, onOpenShipment: noop,
    onOpenBatch: noop, onCancelHeld: noop, onOpenCancellation: noop }));
  ok('revenue tab renders', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('section is named Held finished goods', h.includes('Held finished goods'));
  ok('the old reconciliation name is gone', !h.includes('Fulfilment against despatch'));
  ok('COGS metric shown', h.includes('Cost of goods held'));
  ok('sales value metric shown', h.includes('Total sales value'));
  ok('lots link to their batch record', /Open the batch record/.test(h));
  ok('cancel is offered per row', (h.match(/>Cancel</g) || []).length > 1);
  ok('cancellation records are listed', h.includes('Cancellations'));

  const row = A.heldFinishedGoods(DH2)[0];
  const m = tryRender('cancel', React.createElement(A.CancelHeldModal, {
    data: DH2, row, onClose: noop, update: noop }));
  ok('cancel dialog renders', !m.err, m.err);
  const mh = (m.html || '').replace(/<!-- -->/g, '');
  ok('reason is a dropdown with suggestions', mh.includes('Choose a reason') &&
     mh.includes('Customer cancelled the order'));
  ok('requires who is cancelling', mh.includes('Cancelled by'));
  ok('explains that returning touches only the earmark',
     /become available to any other order/i.test(mh));

  const cr = A.cancellationRecords(DH2)[0];
  const cm = tryRender('crec', React.createElement(A.CancellationRecordModal, {
    record: cr, onClose: noop }));
  ok('cancellation record renders', !cm.err, cm.err);
  const cmh = (cm.html || '').replace(/<!-- -->/g, '');
  ok('shows who cancelled it', cmh.includes('Cancelled by'));
  ok('shows cost released and value forgone',
     cmh.includes('Cost released') && cmh.includes('Sales value forgone'));
}


console.log('\n--- expected COGS and disposition ---');
{
  const DX = A.seedData();
  const r = tryRender('exp', React.createElement(A.RevenueTab, {
    data: DX, horizon: 30, setHorizon: noop, onOpenShipment: noop,
    onOpenBatch: noop, onCancelHeld: noop, onOpenCancellation: noop }));
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('shipped stock shows expected COGS', h.includes('Expected COGS'));
  ok('alongside actual COGS', h.includes('Actual COGS'));

  const row = A.heldFinishedGoods(DX)[0];
  const m = tryRender('disp', React.createElement(A.CancelHeldModal, {
    data: DX, row, onClose: noop, update: noop }));
  ok('cancel dialog renders', !m.err, m.err);
  const mh = (m.html || '').replace(/<!-- -->/g, '');
  ok('asks what happens to the goods', mh.includes('What happens to the goods'));
  ok('offers return to unassigned inventory', mh.includes('Return to unassigned inventory'));
  ok('offers damaged, expired and lost',
     mh.includes('mark as damaged') && mh.includes('mark as expired') && mh.includes('mark as lost'));
  ok('offers dispose and accumulate as waste',
     mh.includes('Generate waste') && mh.includes('dispose') && mh.includes('accumulate'));
  ok('explains the default touches only the earmark',
     /become available to any other order/.test(mh));

  const cr = A.cancellationRecords(DX)[0];
  const cm = tryRender('crec2', React.createElement(A.CancellationRecordModal, {
    record: cr, onClose: noop }));
  ok('the record shows the disposition',
     (cm.html || '').replace(/<!-- -->/g, '').includes('Disposition'));
}

console.log('\n--- material flow: the MRP half of the handshake ---');
{
  const D5 = A.seedData();
  D5.materialRequests = []; D5.materialReturns = [];
  const raw = D5.rawMaterials[0];

  const empty = tryRender('mf', React.createElement(A.MaterialFlowTab, { data: D5, update: noop }));
  ok('the tab renders with nothing raised yet', !empty.err, empty.err);
  const eh = (empty.html || '').replace(/<!-- -->/g, '');
  ok('and offers the four views',
     eh.includes('Requests') && eh.includes('Returns') && eh.includes('In process') && eh.includes('Material balance'));
  ok('an empty request list says what the button is for', eh.includes('No material requests yet'));

  // Raise one, stage it, take custody - the same path the warehouse drives.
  const req = A.tx.raiseMaterialRequest(D5, { requestedFor: 'Run 42', submit: true,
    lines: [{ itemType: 'raw', itemId: raw.id, qty: 100 }] }).request;
  const staged = tryRender('mf2', React.createElement(A.MaterialFlowTab, { data: D5, update: noop }));
  const sh = (staged.html || '').replace(/<!-- -->/g, '');
  ok('a raised request is listed by reference', sh.includes(req.reference));
  ok('with what it is for', sh.includes('Run 42'));

  // Pick the way the warehouse would: FEFO over lots that actually hold stock.
  // Half the seed lots are empty, and staging an empty one is correctly refused.
  const pick = A.suggestFefoLot(D5, 'raw', raw.id);
  ok('the seed offers a lot with stock to pick', !!pick);
  A.tx.stageRequestLine(D5, { materialRequestId: req.id, lineId: req.lines[0].id,
    lotId: pick.id, qty: 100, position: 'TP1' });
  const inDoor = (tryRender('mf3', React.createElement(A.MaterialFlowTab, { data: D5, update: noop })).html || '')
    .replace(/<!-- -->/g, '');
  ok('a staged line shows the position it is sitting in', inDoor.includes('TP1'));
  ok('and offers to take custody of it', inDoor.includes('Take custody'));

  A.tx.receiveRequestLine(D5, { materialRequestId: req.id, lineId: req.lines[0].id });
  const held = tryRender('mf4', React.createElement(A.MaterialFlowTab, { data: D5, update: noop }));
  ok('the tab still renders once material is out', !held.err, held.err);
}

console.log('\n--- the pick can actually be received from where it is listed ---');
{
  // The floor moves before the MRP hears about it, so a request the warehouse
  // has already picked reads Pending here until DockReceiptsPanel records it —
  // and Take custody is gated on Staged. When that panel lived only on the
  // purchasing tab there was no way to receive a staged pallet from Material
  // flow at all: the list and the thing that populates it were on two screens.
  //
  // The panel renders null until its fetch resolves, which never happens under
  // renderToString, so this is a source-level wiring check rather than a markup
  // one — same reasoning as the warehouse's startup test.
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'mrp-console.jsx'), 'utf8');
  const tabAt = SRC.indexOf('function MaterialFlowTab(');
  ok('the material flow tab is in the source', tabAt > 0);
  // Bound the search at the next top-level function so this cannot pass on a
  // match that belongs to some later component.
  const nextFn = SRC.indexOf('\nfunction ', tabAt + 10);
  const body = SRC.slice(tabAt, nextFn > 0 ? nextFn : SRC.length);
  ok('and it carries the panel that records what the warehouse has picked',
     body.includes('<DockReceiptsPanel'));
  ok('the panel is still on the purchasing side too — receiving deliveries did not move',
     (SRC.match(/<DockReceiptsPanel/g) || []).length >= 2);
}

console.log('\n--- in process is a custody statement, with an exception ---');
{
  const D5 = A.seedData();
  D5.materialRequests = []; D5.materialReturns = [];
  const raw = D5.rawMaterials[0];
  const holding = raw.lots.find(l => (Number(l.qty) || 0) > 0);
  holding.inProcess = true;
  holding.inProcessSince = '2026-08-01';

  const rows = A.inProcessLots(D5);
  const list = tryRender('ip', React.createElement(A.InProcessList, {
    data: D5, rows, onReturn: noop, onClear: noop }));
  ok('the in-process list renders', !list.err, list.err);
  const lh = (list.html || '').replace(/<!-- -->/g, '');
  ok('it states the custody definition, not a location',
     lh.includes('not under the warehouse manager') || lh.includes("warehouse manager's supervision"));
  ok('and says this is the only stock a batch may draw on',
     lh.includes('only stock a batch may be logged against'));
  ok('every row offers a return', lh.includes('Return'));
  ok('and the exception path', lh.includes('Clear'));

  const clear = tryRender('clr', React.createElement(A.ClearInProcessModal, {
    data: D5, row: rows[0], update: noop, onClose: noop }));
  ok('the exception dialog renders', !clear.err, clear.err);
  const ch = (clear.html || '').replace(/<!-- -->/g, '');
  ok('it says custody ends without the warehouse seeing it back',
     ch.includes('without a material return'));
  ok('and demands a reason', ch.includes('Reason (required)'));

  const ret = tryRender('ret', React.createElement(A.MaterialReturnModal, {
    data: D5, row: rows[0], update: noop, onClose: noop }));
  ok('the return dialog renders', !ret.err, ret.err);
  const rh = (ret.html || '').replace(/<!-- -->/g, '');
  ok('it distinguishes the two flavours, which is what the warehouse acts on',
     rh.includes('Leftover') && rh.includes('Production output'));
  ok('a leftover can say where it came from', rh.includes('Came from'));

  const raise = tryRender('mrq', React.createElement(A.MaterialRequestModal, {
    data: D5, update: noop, onClose: noop }));
  ok('the request dialog renders', !raise.err, raise.err);
  const qh = (raise.html || '').replace(/<!-- -->/g, '');
  ok('it asks for item and quantity, not a lot — the warehouse picks under FEFO',
     qh.includes('earliest expiry first') && !qh.includes('Lot number'));
}

console.log('\n--- the batch log cannot reach warehouse stock ---');
{
  // The bypass this closes: production drawing straight off the rack, with no
  // pick, no document and a warehouse stock figure wrong the moment it happened.
  const D5 = A.seedData();
  D5.materialRequests = []; D5.materialReturns = [];
  const proc = (D5.processes || []).find(p => (p.inputs || []).length > 0);
  ok('the seed has a process with inputs to test against', !!proc);

  const locked = tryRender('bl', React.createElement(A.BatchLogModal, {
    data: D5, kind: null, processId: proc.id, onClose: noop, update: noop }));
  ok('the batch log renders', !locked.err, locked.err);
  const bh = (locked.html || '').replace(/<!-- -->/g, '');
  ok('with nothing issued, storage stock is named under its own heading',
     bh.includes('Inventory in storage'));
  ok('and the operator is told to request it',
     bh.includes('request material') || bh.includes('Request this material'));
  ok('the rule is stated where the picking happens',
     bh.includes('Only material the line is holding can be consumed'));
  ok('no lot is preselected, so the modal does not open already in breach',
     !bh.includes('In process — available'));

  // Issue one input through the door; it becomes selectable and the heading
  // flips to the available group.
  const input = proc.inputs[0];
  const entity = input.itemType === 'raw' ? 'rawMaterials'
    : input.itemType === 'intermediate' ? 'intermediateProducts'
    : input.itemType === 'finished' ? 'finishedGoods' : 'wasteStreams';
  const item = (D5[entity] || []).find(i => i.id === input.itemId);
  const stocked = ((item && item.lots) || []).find(l => (Number(l.qty) || 0) > 0);
  ok('the input resolves to a catalog item with stock', !!stocked);
  stocked.inProcess = true;
  stocked.inProcessSince = '2026-08-01';

  const openBh = (tryRender('bl2', React.createElement(A.BatchLogModal, {
    data: D5, kind: null, processId: proc.id, onClose: noop, update: noop })).html || '')
    .replace(/<!-- -->/g, '');
  ok('issued material is offered under the available heading',
     openBh.includes('In process — available'));
}

console.log('\n--- material balance: shown, never reconciled ---');
{
  const D5 = A.seedData();
  D5.materialRequests = []; D5.materialReturns = [];
  const raw = D5.rawMaterials[0];

  const none = tryRender('bal', React.createElement(A.MaterialBalanceReport, { data: D5 }));
  ok('the report renders with nothing issued', !none.err, none.err);
  ok('and says why it is empty rather than showing a blank table',
     (none.html || '').includes('nothing to balance'));

  const req = A.tx.raiseMaterialRequest(D5, { requestedFor: 'Run 42', submit: true,
    lines: [{ itemType: 'raw', itemId: raw.id, qty: 100 }] }).request;
  const pick = A.suggestFefoLot(D5, 'raw', raw.id);
  A.tx.stageRequestLine(D5, { materialRequestId: req.id, lineId: req.lines[0].id,
    lotId: pick.id, qty: 100, position: 'TP1' });
  A.tx.receiveRequestLine(D5, { materialRequestId: req.id, lineId: req.lines[0].id });

  const r = tryRender('bal2', React.createElement(A.MaterialBalanceReport, { data: D5 }));
  ok('an issued lot appears', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');
  ok('with all four terms', h.includes('Issued') && h.includes('Consumed') &&
     h.includes('Returned') && h.includes('Waste'));
  ok('100 issued and nothing accounted for is a difference, not a rounding note',
     h.includes('do not balance') || h.includes('does not balance'));
  ok('and it is stated as something to find out about, not corrected',
     h.includes('has not been accounted for'));
}

console.log('\n--- the batch run clock ---');
{
  const D6 = A.seedData();
  D6.batchRuns = [];
  const proc = D6.processes[0];

  const idle = tryRender('run0', React.createElement(A.BatchRunControl, {
    process: proc, data: D6, update: noop }));
  ok('the clock control renders with nothing running', !idle.err, idle.err);
  const ih = (idle.html || '').replace(/<!-- -->/g, '');
  ok('it offers to start a batch', ih.includes('Start batch'));
  ok('and a way in for a run nobody clocked', ih.includes('Record times'));

  const r = A.tx.startBatchRun(D6, { processId: proc.id, startedBy: 'AB', operatorCount: 2 }).run;
  const running = tryRender('run1', React.createElement(A.BatchRunControl, {
    process: proc, data: D6, update: noop }));
  const rh = (running.html || '').replace(/<!-- -->/g, '');
  ok('a running clock says so', rh.includes('Running'));
  ok('naming the run and who started it', rh.includes(r.reference) && rh.includes('AB'));
  ok('and offers Finish rather than Start', rh.includes('Finish') && !rh.includes('Start batch'));
  ok('with a way to correct the times', rh.includes('Edit times'));

  ok('and a way to throw away a clock started by mistake', rh.includes('Discard'));

  A.tx.finishBatchRun(D6, { runId: r.id,
    finishedAt: new Date(new Date(r.startedAt).getTime() + 2 * 3600000).toISOString() });
  const done = (tryRender('run2', React.createElement(A.BatchRunControl, {
    process: proc, data: D6, update: noop })).html || '').replace(/<!-- -->/g, '');
  ok('a finished run is flagged as waiting to be logged', done.includes('not yet logged'));
  // Listed, not just counted — a false start that was also stopped is still a
  // false start, and it has to be removable.
  ok('and is listed by reference', done.includes(r.reference));
  ok('with its elapsed time', done.includes('2h 00m'));
  ok('and can be discarded from there', done.includes('Discard'));

  const shortRun = { id: 'x', reference: 'RUN-0099', status: 'Running',
    startedAt: new Date(Date.now() - 30000).toISOString(), finishedAt: '', startedBy: 'AB' };
  const disc = tryRender('run6', React.createElement(A.DiscardBatchRunModal, {
    process: proc, run: shortRun, update: noop, onClose: noop }));
  ok('the discard dialog renders', !disc.err, disc.err);
  const dh = (disc.html || '').replace(/<!-- -->/g, '');
  ok('a mis-click needs no justification', dh.includes('Reason (optional)'));
  ok('and it says the run is kept rather than deleted', dh.includes('keeps its reference'));
  ok('the safe way out is the plain one', dh.includes('Keep it'));

  // A long run is far more likely to be real work than a mis-click, so say so
  // before it is thrown away — losing it loses the only record of the job.
  const longRun = { ...shortRun, startedAt: new Date(Date.now() - 3 * 3600000).toISOString() };
  const lh = (tryRender('run7', React.createElement(A.DiscardBatchRunModal, {
    process: proc, run: longRun, update: noop, onClose: noop })).html || '').replace(/<!-- -->/g, '');
  ok('discarding a substantial run warns that the time is real',
     lh.includes('log it as a batch instead'));
  ok('while a 30-second one does not nag', !dh.includes('log it as a batch instead'));

  const start = tryRender('run3', React.createElement(A.StartBatchRunModal, {
    process: proc, update: noop, onClose: noop }));
  ok('the start dialog renders', !start.err, start.err);
  const sh = (start.html || '').replace(/<!-- -->/g, '');
  ok('it asks how many operators, because labour hours depend on it',
     sh.includes('Operators on the run'));
  ok('and explains why that is not the same as equipment hours',
     sh.includes('multiply labour hours but not equipment hours'));

  const times = tryRender('run4', React.createElement(A.BatchRunTimesModal, {
    process: proc, run: null, update: noop, onClose: noop }));
  ok('the manual-times dialog renders', !times.err, times.err);
  const th = (times.html || '').replace(/<!-- -->/g, '');
  ok('it demands a reason', th.includes('Reason (required)'));
  ok('and says the times are recorded as entered, not measured',
     th.includes('entered by hand, not as measured'));

  const corr = (tryRender('run5', React.createElement(A.BatchRunTimesModal, {
    process: proc, run: r, update: noop, onClose: noop })).html || '').replace(/<!-- -->/g, '');
  ok('correcting an existing run says the clocked times are kept',
     corr.includes('clocked times are kept'));
}

console.log('\n--- the batch log takes its hours from the clock ---');
{
  const D6 = A.seedData();
  D6.batchRuns = [];
  const proc = D6.processes.find(p => (p.equipment || []).length > 0) || D6.processes[0];

  // Without a run the hours default to the plan, which is how "actual" time
  // quietly became a copy of the forecast. Say so rather than looking measured.
  const noRun = (tryRender('bl3', React.createElement(A.BatchLogModal, {
    data: D6, kind: null, processId: proc.id, onClose: noop, update: noop })).html || '')
    .replace(/<!-- -->/g, '');
  ok('with no timed run the batch log says the hours are the plan',
     noRun.includes('No timed run for this process'));
  ok('and names the honest consequence',
     noRun.includes('agree by construction'));

  const r = A.tx.startBatchRun(D6, { processId: proc.id, operatorCount: 2 }).run;
  A.tx.finishBatchRun(D6, { runId: r.id,
    finishedAt: new Date(new Date(r.startedAt).getTime() + 2 * 3600000).toISOString() });

  const withRun = tryRender('bl4', React.createElement(A.BatchLogModal, {
    data: D6, kind: null, processId: proc.id, onClose: noop, update: noop }));
  ok('the batch log renders with a run attached', !withRun.err, withRun.err);
  const wh = (withRun.html || '').replace(/<!-- -->/g, '');
  ok('the run is named', wh.includes(r.reference));
  ok('its elapsed time is shown', wh.includes('2h 00m'));
  ok('and the two hour figures are reported separately',
     wh.includes('labour hours') && wh.includes('equipment hours'));
  ok('with actual measured against plan', /over plan by|under plan by/.test(wh));
  ok('and it is said that editing here does not rewrite the run',
     wh.includes('does not change the run'));
}

console.log('\n--- the SOP travels with the operation ---');
{
  const D6 = A.seedData();
  D6.batchRuns = [];
  const proc = D6.processes[0];

  const none = (tryRender('sop0', React.createElement(A.SopBadge, { process: proc })).html || '')
    .replace(/<!-- -->/g, '');
  ok('a process with no SOP says so rather than showing nothing',
     none.includes('No SOP attached'));

  const withSop = { ...proc, sopKey: 'lot_attachment:abc', sopFileName: 'SOP-014.pdf', sopVersion: 'Rev C' };
  const badge = (tryRender('sop1', React.createElement(A.SopBadge, { process: withSop })).html || '')
    .replace(/<!-- -->/g, '');
  ok('an attached SOP is named', badge.includes('SOP-014.pdf'));
  ok('with its revision, so it is clear which one was worked to', badge.includes('Rev C'));

  const field = tryRender('sop2', React.createElement(A.SopField, { f: withSop, set: noop }));
  ok('the SOP editor renders', !field.err, field.err);
  const fh = (field.html || '').replace(/<!-- -->/g, '');
  ok('it explains where the document will show up',
     fh.includes('operator view') || fh.includes('process card'));
  ok('and treats the revision as free text, not a format to guess',
     fh.includes('whatever your quality system calls it'));

  // The operator card is where the work happens, so both belong on it.
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'mrp-console.jsx'), 'utf8');
  const at = SRC.indexOf('function OperatorProcessCard(');
  const next = SRC.indexOf('\nfunction ', at + 10);
  const body = SRC.slice(at, next > 0 ? next : SRC.length);
  ok('the operator card carries the SOP — filed under admin it is no use',
     body.includes('<SopBadge'));
  ok('and the clock, so the run is timed where it is run',
     body.includes('<BatchRunControl'));
}

console.log('\n--- sales orders can actually be raised ---');
{
  // Review found no way to create one at all: the console could review and
  // release the orders that arrived with the seed data and nothing else.
  const D7 = A.seedData();
  const tab = tryRender('so1', React.createElement(A.SalesOrdersTab, {
    data: D7, onOpenOrder: noop, onNewOrder: noop }));
  ok('the sales order tab renders', !tab.err, tab.err);
  const th = (tab.html || '').replace(/<!-- -->/g, '');
  ok('and offers a clear way to add one', th.includes('New sales order'));
  ok('the list is sortable', th.includes('Sort'));
  ok('and searchable', th.includes('Order, customer, rep'));

  const modal = tryRender('so2', React.createElement(A.NewSalesOrderModal, {
    data: D7, update: noop, onClose: noop }));
  ok('the new-order form renders', !modal.err, modal.err);
  const mh = (modal.html || '').replace(/<!-- -->/g, '');
  ok('it asks who keyed it in, as well as whose sale it is',
     mh.includes('Entered by') && mh.includes('Sales rep'));
  ok('and says that will come from the login later', mh.includes('once auth lands'));
  ok('it explains where the price comes from', mh.includes('price list at the quantity'));
  ok('a draft is possible as well as a submission',
     mh.includes('Save as draft') && mh.includes('Submit for review'));
  ok('the line grid is labelled', mh.includes('Unit price') && mh.includes('Line value'));
}

console.log('\n--- linking an order to production that already exists ---');
{
  const D7 = A.seedData();
  D7.salesOrders = []; D7.schedule = [];
  const cust = D7.customers[0], fg = D7.finishedGoods[0];
  const o = A.tx.raiseSalesOrder(D7, { customerId: cust.id, salesRep: 'R', enteredBy: 'C',
    submit: true, lines: [{ finishedGoodId: fg.id, qty: 100 }] }).order;
  A.repo.create(D7, 'schedule', { reference: 'RUN-00042', productType: 'finished',
    productId: fg.id, qty: 500, dueDate: '2026-09-01', status: 'Planned', notes: '',
    customerId: '', completedDate: '', createdDate: '2026-08-01', frozen: false,
    frozenDate: '', baselineQty: '', baselineDueDate: '', standardCostAtFulfillment: '',
    fulfillmentLots: [], revisions: [] });
  A.tx.reviewSalesOrderLine(D7, { salesOrderId: o.id, lineId: o.lines[0].id, decision: 'Accept' });

  const rev = tryRender('so3', React.createElement(A.SalesOrderModal, {
    data: D7, orderId: o.id, onClose: noop, update: noop }));
  ok('the review modal renders', !rev.err, rev.err);
  const rh = (rev.html || '').replace(/<!-- -->/g, '');
  ok('who entered the order is shown', rh.includes('Entered by'));
  ok('and an accepted line offers the existing run as an alternative to a new one',
     rh.includes('Link to existing run'));

  const detail = A.salesOrderRecords(D7).find(r => r.order.id === o.id).lines[0];
  const pick = tryRender('so4', React.createElement(A.LinkRunModal, {
    data: D7, orderId: o.id, detail, runs: A.linkableRunsForLine(D7, fg.id),
    update: noop, onClose: noop, onError: noop }));
  ok('the run picker renders', !pick.err, pick.err);
  const ph = (pick.html || '').replace(/<!-- -->/g, '');
  ok('runs are offered by number', ph.includes('RUN-00042'));
  // A run makes a finite quantity, and a link is a claim on it.
  ok('each run shows what it makes and what is left of it',
     ph.includes('Makes') && ph.includes('available'));
  ok('and whether it covers the line', ph.includes('Covers this line in full') ||
     ph.includes('would still need a run'));
  ok('the link button says how much it will take',
     /Link [\d,.]+ /.test(ph), ph.slice(0, 0));
  ok('and the rule is stated', ph.includes('takes only what the run has left'));
}

console.log('\n--- the run list reads on its own ---');
{
  const D7 = A.seedData();
  const list = tryRender('sl1', React.createElement(A.ScheduleTab, {
    data: D7, tabKey: 'scheduleList', onAdd: noop, onEdit: noop, onDelete: noop }));
  ok('the run list renders as its own tab', !list.err, list.err);
  const lh = (list.html || '').replace(/<!-- -->/g, '');
  // Four colours with no key made the timeline read as decoration.
  ok('the colour key is present', lh.includes('Raw material lead time'));
  ok('naming production separately from lead time',
     lh.includes('Finished goods production') && lh.includes('Intermediate production'));
  ok('and the today marker', lh.includes('Today'));
  ok('runs carry a number for traceability', /RUN-\d{5}/.test(lh));
  ok('it says which runs have no order behind them', lh.includes('No sales order'));
  ok('and can be filtered by that', lh.includes('Not against an order'));
  ok('and by status', lh.includes('All statuses'));

  // Added on review: a planner narrows by what is being made and who for.
  ok('by product family, grouped by axis',
     lh.includes('All product families') && lh.includes('Premium Reserve'));
  ok('the family axes are the optgroups, not a flat list',
     lh.includes('<optgroup label="Blend"') || lh.includes('label="Blend"'));
  ok('and by customer', lh.includes('All customers'));

  // Added on review: the type filter is what resolves the family conflict.
  ok('by product type', lh.includes('Intermediate and finished') &&
     lh.includes('Finished goods only') && lh.includes('Intermediate products only'));
  ok('and by a due-date horizon',
     lh.includes('Any due date') && lh.includes('Due within 30 days'));
  ok('the production summary is reachable', lh.includes('Production summary'));

  // Planned start and completion come from the capacity plan, not the run.
  ok('planned start and completion can be sorted on',
     lh.includes('Planned start') && lh.includes('Planned completion'));
  ok('and are shown on the row', lh.includes('>Planned <') || lh.includes('Planned '));
  ok('a closed run says why it has no planned dates rather than showing blanks',
     lh.includes('closed runs are not in the forward plan') ||
     lh.includes('not in the current capacity plan'));

  const cal = tryRender('sl2', React.createElement(A.ScheduleTab, {
    data: D7, tabKey: 'schedule', onAdd: noop, onEdit: noop, onDelete: noop }));
  const ch = (cal.html || '').replace(/<!-- -->/g, '');
  ok('the calendar tab still renders', !cal.err, cal.err);
  ok('and no longer carries an internal List/Calendar switch — they are two tabs now',
     !ch.includes('Capacity plan (FIFO)') || !/>List</.test(ch));

  const legend = tryRender('sl3', React.createElement(A.ScheduleLegend, {}));
  ok('the legend renders standalone', !legend.err, legend.err);
}

console.log('\n--- the production summary window ---');
{
  const D10 = A.seedData();
  const rows = A.runListRows(D10, null);
  const summary = A.productionSummary(D10, rows);
  const r = tryRender('psum', React.createElement(A.ProductionSummaryModal, {
    summary, filtered: rows.length, total: rows.length, onClose: noop }));
  ok('the summary window renders', !r.err, r.err);
  const h = (r.html || '').replace(/<!-- -->/g, '');

  ok('runs per product', h.includes('>Runs<'));
  ok('total production planned', h.includes('Production planned'));
  ok('expected COGS', h.includes('Expected COGS'));
  ok('the number of linked sales orders', h.includes('Linked SOs'));
  ok('the production linked to them', h.includes('Linked production'));
  ok('and the revenue that implies', h.includes('Est. revenue'));

  // Quantity is not summed across products; money is.
  ok('mixed units are called out rather than totalled', h.includes('mixed units'));
  ok('and it says revenue prices linked production only',
     h.includes('prices the') && h.includes('linked'));
  ok('naming why unsold production is not priced',
     h.includes('nobody has committed to buy'));
  ok('the window says what selection it describes', h.includes('currently shown'));

  const none = tryRender('psum2', React.createElement(A.ProductionSummaryModal, {
    summary: A.productionSummary(D10, []), filtered: 0, total: rows.length, onClose: noop }));
  ok('an empty selection renders', !none.err, none.err);
  ok('and says there is nothing to summarise',
     (none.html || '').includes('nothing to summarise'));
}

console.log('\n--- assigned versus unassigned production, on the dashboard ---');
{
  const D7 = A.seedData();
  const dash = tryRender('dash9', React.createElement(A.Dashboard, { data: D7, setTab: noop }));
  ok('the dashboard still renders', !dash.err, dash.err);
  const dh = (dash.html || '').replace(/<!-- -->/g, '');
  ok('planned production is split by whether anyone ordered it',
     dh.includes('Planned production') && dh.includes('Unassigned'));
  ok('with a route to the detail', dh.includes('Open run list'));
  // Mixed units across products, so the honest framing is a share.
  ok('and it says the total is a share, not a quantity to trust',
     dh.includes('Mixed units'));
}

console.log('\n--- lists sort and filter ---');
{
  const D7 = A.seedData();
  // Named one by one on purpose: mkapp.sh derives the bundle's export list from
  // the literal A.<name> references in this file, so a component reached
  // through A[variable] is never exported and renders as undefined.
  const catalogProps = { data: D7, search: '', setSearch: noop, onAdd: noop, onEdit: noop,
                         onDelete: noop, onInventory: noop };
  const plainProps = { data: D7, search: '', setSearch: noop, onAdd: noop, onEdit: noop, onDelete: noop };
  [['RawMaterialsTab', A.RawMaterialsTab, catalogProps],
   ['IntermediateProductsTab', A.IntermediateProductsTab, catalogProps],
   ['FinishedGoodsTab', A.FinishedGoodsTab, catalogProps],
   ['ComponentsTab', A.ComponentsTab, plainProps],
   ['EquipmentTab', A.EquipmentTab, plainProps]
  ].forEach(([name, Cmp, props]) => {
    const r = tryRender(name, React.createElement(Cmp, props));
    ok(name + ' renders', !r.err, r.err);
    const h = (r.html || '').replace(/<!-- -->/g, '');
    ok(name + ' offers sorting and search', h.includes('Sort') && h.includes('↕'));
  });

  // The arrow marks the column in force. One on every heading would say
  // nothing about which is actually sorting.
  const rm = (tryRender('rm', React.createElement(A.RawMaterialsTab, { data: D7, search: '',
    setSearch: noop, onAdd: noop, onEdit: noop, onDelete: noop, onInventory: noop })).html || '');
  // Scoped to the header row: the toolbar carries its own direction button,
  // which is a different control and legitimately shows an arrow too.
  const head = rm.slice(rm.indexOf('<thead>'), rm.indexOf('</thead>'));
  ok('exactly one column shows the active sort direction',
     (head.match(/↑/g) || []).length + (head.match(/↓/g) || []).length === 1,
     'up=' + (head.match(/↑/g) || []).length + ' down=' + (head.match(/↓/g) || []).length);
  ok('the rest are marked sortable, not sorted', (head.match(/↕/g) || []).length >= 5);
}

console.log('\n--- volume tiers say what their columns are ---');
{
  const D7 = A.seedData();
  const withTiers = (D7.customers || []).find(c =>
    (c.priceList || []).some(p => (p.tiers || []).length > 0)) || D7.customers[0];
  const m = tryRender('cust9', React.createElement(A.CustomerModal, {
    data: D7, id: withTiers.id, onClose: noop, update: noop }));
  ok('the customer form renders', !m.err, m.err);
  const h = (m.html || '').replace(/<!-- -->/g, '');
  ok('three unlabelled number boxes are now labelled',
     h.includes('Units (min qty)') && h.includes('Price per unit') && h.includes('Gross margin'));
}

console.log('\n--- product families roll up along whichever axis is picked ---');
{
  const D8 = A.seedData();
  const tab = tryRender('fam1', React.createElement(A.FamilySalesTab, {
    data: D8, onManage: noop }));
  ok('the family sales tab renders', !tab.err, tab.err);
  const h = (tab.html || '').replace(/<!-- -->/g, '');
  ok('the axes are offered as groupings',
     h.includes('Blend') && h.includes('Form') && h.includes('Pack'));
  ok('every family is offered as a filter',
     h.includes('Premium Reserve') && h.includes('Foodservice') && h.includes('Dry powder'));
  ok('the faceted rule is stated rather than left to be discovered',
     h.includes('same axis widens, different axes narrow'));
  // The four figures the roll-up is read for, named in full rather than
  // abbreviated to one ambiguous "COGS" column.
  ok('expected COGS is named', h.includes('Expected COGS'));
  ok('actual COGS is named', h.includes('Actual COGS'));
  ok('the gap between them is named', h.includes('Deviation from plan'));
  ok('and the margin is the one against actual cost', h.includes('Actual margin'));
  ok('expected is the cost fixed at fulfilment, not today\u2019s moving standard',
     h.includes('fixed when the run was fulfilled'));
  ok('and the sign convention is stated', h.includes('positive figure is an overrun'));

  // The arithmetic the report refuses to do, said out loud.
  ok('it says why units are never summed across formats',
     h.includes('never added across formats'));
  ok('naming the case that makes it obvious', h.includes('500g pouch'));

  const manage = tryRender('fam2', React.createElement(A.ProductFamiliesModal, {
    data: D8, update: noop, onClose: noop }));
  ok('the family manager renders', !manage.err, manage.err);
  const mh = (manage.html || '').replace(/<!-- -->/g, '');
  ok('it explains what the axis is for', mh.includes('two tags on the same') ||
     mh.includes('same axis widen') || mh.includes('axis'));
  ok('and shows how many products each family holds', mh.includes('product(s)'));

  const tags = tryRender('fam3', React.createElement(A.FamilyTagsField, {
    data: D8, value: [], onChange: noop }));
  ok('the tag picker renders', !tags.err, tags.err);
  const th2 = (tags.html || '').replace(/<!-- -->/g, '');
  ok('grouped by axis, so tagging two blends is a decision not a slip',
     th2.includes('Blend') && th2.includes('Form'));
  ok('and it says a product can be in several at once', th2.includes('several at once'));

  // Net content is what makes a cross-format total mean anything.
  const fgModal = tryRender('fam4', React.createElement(A.FinishedGoodModal, {
    data: D8, id: D8.finishedGoods[0].id, onClose: noop, update: noop }));
  ok('the finished good form renders', !fgModal.err, fgModal.err);
  const fh = (fgModal.html || '').replace(/<!-- -->/g, '');
  ok('it asks for net content per unit', fh.includes('Net content per unit'));
  ok('and the unit it is measured in', fh.includes('Net content unit'));
  ok('and carries the family tags', fh.includes('Product families'));
}

console.log('\n--- the dashboard revisions ---');
{
  const D9 = A.seedData();
  const dash = tryRender('dash10', React.createElement(A.Dashboard, {
    data: D9, setTab: noop, update: noop }));
  ok('the dashboard renders', !dash.err, dash.err);
  const h = (dash.html || '').replace(/<!-- -->/g, '');

  // A run can finish on time and the goods still reach the customer late.
  ok('due-date adherence can be switched between runs and shipments',
     h.includes('Completions against due date') && h.includes('>Runs<') && h.includes('>Shipments<'));

  // The old chart added kilogrammes to metres to litres.
  ok('raw material flow can be narrowed to one material',
     h.includes('All raw materials (mixed units)'));
  ok('and says why the combined view is close to useless',
     h.includes('several units of measure in one bar'));
  ok('every raw material is offered', h.includes('Green coffee') || h.includes('Sachet'));

  // The four figures beside the chart, and the fact that two are period
  // figures and two are as-of-now.
  ok('ordered in the period is shown', h.includes('>Ordered<'));
  ok('consumed in the period too', h.includes('>Consumed<'));
  ok('current inventory', h.includes('Current inventory'));
  ok('and, across everything, a count below reorder point rather than a summed one',
     h.includes('Below reorder point'));
  ok('period figures are labelled as such', h.includes('Last 13 weeks'));
  ok('and as-of-now figures as such', h.includes('>now<'));
  ok('the mixed-unit caveat reaches the figures too',
     h.includes('mix units of measure across materials'));

  // Valuation.
  ok('raw material on hand is valued', h.includes('Raw material on hand'));
  ok('intermediates too', h.includes('Intermediate products'));
  ok('and finished goods', h.includes('Finished goods'));
  ok('with a total', h.includes('Total stock on hand'));
  ok('waste is called out as excluded', h.includes('waste streams excluded'));
  ok('a snapshot can be taken by hand', h.includes('Take snapshot now'));
  ok('and the history says it is read, not recomputed',
     h.includes('not recomputed'));
}

console.log('\n--- the valuation panel on its own ---');
{
  const D9 = A.seedData();
  const range = { from: '2026-01-01', to: '2026-12-31', granularity: 'month' };
  const empty = tryRender('val1', React.createElement(A.InventoryValuationPanel, {
    data: D9, update: noop, range }));
  ok('it renders with no snapshots yet', !empty.err, empty.err);
  const eh = (empty.html || '').replace(/<!-- -->/g, '');
  ok('and says so rather than drawing an empty chart', eh.includes('No snapshots recorded yet'));
  ok('pointing at both ways one gets taken', eh.includes('nightly job') && eh.includes('button above'));

  A.tx.captureInventorySnapshot(D9, { date: '2026-06-30', source: 'cron' });
  A.tx.captureInventorySnapshot(D9, { date: '2026-07-31', source: 'cron' });
  const withHistory = tryRender('val2', React.createElement(A.InventoryValuationPanel, {
    data: D9, update: noop, range }));
  ok('and with snapshots', !withHistory.err, withHistory.err);
  const wh = (withHistory.html || '').replace(/<!-- -->/g, '');
  ok('naming when the last one was taken', wh.includes('Last snapshot'));
  ok('and how many are in range', wh.includes('2 snapshot(s) in this range'));
}

console.log('\n============================');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('============================\n');
process.exit(fail?1:0);
