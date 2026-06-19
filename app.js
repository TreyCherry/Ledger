/* ============================================================================
   Ledger — offline budgeting PWA
   All computation runs on-device. No network calls, no external libraries.
   Persistence: localStorage (synchronous, reliable in airplane mode).
   ========================================================================== */
(function () {
  'use strict';

  /* ---- Constants -------------------------------------------------------- */
  const KEY = 'ledger.v1';
  const HORIZON_DAYS = 30;          // length of "The Month Ahead" projection

  // Purchase categories with stable colors (also used for bills/subs metadata)
  const CATS = [
    { id: 'groceries',     name: 'Groceries',     color: '#2f7d5b' },
    { id: 'dining',        name: 'Dining',        color: '#c0563d' },
    { id: 'transport',     name: 'Transport',     color: '#3a6ea5' },
    { id: 'shopping',      name: 'Shopping',      color: '#9a5ba8' },
    { id: 'health',        name: 'Health',        color: '#2a9d9b' },
    { id: 'entertainment', name: 'Entertainment', color: '#c98a2b' },
    { id: 'home',          name: 'Home',          color: '#8a6f4a' },
    { id: 'utilities',     name: 'Utilities',     color: '#5a6b3a' },
    { id: 'other',         name: 'Other',         color: '#7c7f8b' }
  ];
  const catById = (id) => CATS.find((c) => c.id === id) || CATS[CATS.length - 1];

  const CYCLES = [
    { id: 'weekly',  name: 'Weekly'  },
    { id: 'monthly', name: 'Monthly' },
    { id: 'yearly',  name: 'Yearly'  }
  ];
  const cycleName = (id) => (CYCLES.find((c) => c.id === id) || {}).name || '';

  /* ---- State ------------------------------------------------------------ */
  const DEFAULT_STATE = {
    settings: { currency: '$', startBalance: 0 },
    income: [], bills: [], subscriptions: [], purchases: [],
    budgets: {}                // { [categoryId]: amount allocated this period }
  };
  let state = load();
  let activeTab = 'budget';
  let editing = null;          // { type, id } | null
  let draft = null;            // working copy in the sheet
  let budgetEditing = null;    // categoryId | null (null = adding a new envelope)

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return structuredClone(DEFAULT_STATE);
      const parsed = JSON.parse(raw);
      return Object.assign(structuredClone(DEFAULT_STATE), parsed, {
        settings: Object.assign({}, DEFAULT_STATE.settings, parsed.settings)
      });
    } catch (e) {
      return structuredClone(DEFAULT_STATE);
    }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* ---- Small helpers ---------------------------------------------------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function money(n) {
    const cur = state.settings.currency || '';
    const v = Math.abs(Number(n) || 0);
    const body = v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-' : '') + cur + body;
  }
  function signed(n) {
    const cur = state.settings.currency || '';
    const v = Math.abs(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '−' : '+') + cur + v;
  }

  // Parse 'YYYY-MM-DD' as a *local* date (avoids timezone off-by-one)
  function parseDate(str) {
    if (!str) return null;
    const [y, m, d] = str.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function toISO(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function today() { return startOfDay(new Date()); }
  function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }
  const dayMs = 86400000;

  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDay(d) { return { wd: WD[d.getDay()], md: `${MO[d.getMonth()]} ${d.getDate()}` }; }

  /* ---- Recurrence: occurrences of an item within [start, end] ----------- */
  // anchor is a Date; cycle in {weekly, monthly, yearly}; non-recurring → single.
  function occurrences(anchor, cycle, recurring, start, end) {
    if (!anchor) return [];
    if (!recurring) {
      const a = startOfDay(anchor);
      return (a >= start && a <= end) ? [a] : [];
    }
    const out = [];
    const aDay = anchor.getDate();
    if (cycle === 'weekly') {
      // step k from an index that lands on/just before start
      let k = Math.floor((start - startOfDay(anchor)) / (7 * dayMs)) - 1;
      for (let i = 0; i < 600; i++, k++) {
        const occ = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 7 * k);
        const o = startOfDay(occ);
        if (o > end) break;
        if (o >= start) out.push(o);
      }
    } else if (cycle === 'yearly') {
      for (let y = start.getFullYear() - 1; y <= end.getFullYear() + 1; y++) {
        const dim = daysInMonth(y, anchor.getMonth());
        const occ = new Date(y, anchor.getMonth(), Math.min(aDay, dim));
        if (occ >= start && occ <= end) out.push(occ);
      }
    } else { // monthly — index by month offset to avoid day drift
      const monthsBetween = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
      let k = monthsBetween(anchor, start) - 1;
      for (let i = 0; i < 200; i++, k++) {
        const y = anchor.getFullYear();
        const mo = anchor.getMonth() + k;
        const yy = y + Math.floor(mo / 12);
        const mm = ((mo % 12) + 12) % 12;
        const occ = new Date(yy, mm, Math.min(aDay, daysInMonth(yy, mm)));
        if (occ > end) break;
        if (occ >= start) out.push(occ);
      }
    }
    return out;
  }

  /* ---- Projection engine: events within the horizon, running balance ---- */
  function buildProjection() {
    const start = today();
    const end = new Date(start.getTime() + HORIZON_DAYS * dayMs);
    const events = [];

    const push = (date, label, sub, amount, dir) =>
      events.push({ date, label, sub, amount, dir });

    state.income.forEach((it) => {
      occurrences(parseDate(it.date), it.cycle, !!it.recurring, start, end)
        .forEach((d) => push(d, it.source || 'Income', it.recurring ? cycleName(it.cycle) : 'One-off', it.amount, 'in'));
    });
    state.bills.forEach((it) => {
      occurrences(parseDate(it.date), it.cycle, !!it.recurring, start, end)
        .forEach((d) => push(d, it.name || 'Bill', it.recurring ? cycleName(it.cycle) : 'One-off', it.amount, 'out'));
    });
    state.subscriptions.forEach((it) => {
      if (it.active === false) return;
      occurrences(parseDate(it.date), it.cycle, true, start, end)
        .forEach((d) => push(d, it.name || 'Subscription', cycleName(it.cycle), it.amount, 'out'));
    });

    events.sort((a, b) => a.date - b.date || (a.dir === b.dir ? 0 : a.dir === 'in' ? -1 : 1));

    let bal = Number(state.settings.startBalance) || 0;
    let low = { bal: bal, date: start, idx: -1 };
    events.forEach((ev, i) => {
      bal += (ev.dir === 'in' ? 1 : -1) * (Number(ev.amount) || 0);
      ev.running = bal;
      if (bal < low.bal) low = { bal: bal, date: ev.date, idx: i };
    });
    return { events, endBalance: bal, low, start, end };
  }

  /* ---- Rolling 30-day windows ------------------------------------------- */
  // Trailing window [today-30, today] for things that already happened (spend);
  // forward window [today, today+30] for things coming up (upcoming payments).
  function windows() {
    const t = today();
    return {
      t,
      back: new Date(t.getTime() - HORIZON_DAYS * dayMs),
      fwd: new Date(t.getTime() + HORIZON_DAYS * dayMs)
    };
  }

  /* ---- Trailing-30-day figures (for the Overview summary) --------------- */
  function monthFigures() {
    const { t, back } = windows();
    const sum = (arr, recDefault) => arr.reduce((acc, it) => {
      const rec = recDefault === undefined ? !!it.recurring : recDefault;
      return acc + occurrences(parseDate(it.date), it.cycle, rec, back, t).length * (Number(it.amount) || 0);
    }, 0);

    const incomeTotal = sum(state.income);
    const billsTotal = sum(state.bills);
    const subsTotal = state.subscriptions.reduce((acc, it) => {
      if (it.active === false) return acc;
      return acc + occurrences(parseDate(it.date), it.cycle, true, back, t).length * (Number(it.amount) || 0);
    }, 0);

    const byCat = {};
    let purchaseTotal = 0;
    state.purchases.forEach((p) => {
      const d = parseDate(p.date);
      if (d && d >= back && d <= t) {
        const amt = Number(p.amount) || 0;
        purchaseTotal += amt;
        byCat[p.category || 'other'] = (byCat[p.category || 'other'] || 0) + amt;
      }
    });

    return {
      income: incomeTotal,
      recurringOut: billsTotal + subsTotal,
      purchases: purchaseTotal,
      net: incomeTotal - billsTotal - subsTotal - purchaseTotal,
      byCat,
      windowLabel: 'Last 30 days'
    };
  }

  /* ---- Budget engine ----------------------------------------------------- */
  // Trailing spend (purchases) + upcoming payments (bills/subs) per category.
  // Upcoming amounts are soft-marked out of the category's own envelope money,
  // soonest due first — never out of the unassigned pool.
  function computeBudget() {
    const { t, back, fwd } = windows();
    const budgets = state.budgets || {};
    const per = {};
    const ensure = (c) => (per[c] || (per[c] = {
      cat: c, budgeted: Number(budgets[c]) || 0,
      spent: 0, upcomingTotal: 0, earmarked: 0, free: 0, shortfall: 0, overspent: 0, occ: []
    }));

    // Every funded category gets an envelope, even with no activity
    Object.keys(budgets).forEach((c) => { if (Number(budgets[c]) > 0) ensure(c); });

    // Trailing spend from purchases
    state.purchases.forEach((p) => {
      const d = parseDate(p.date);
      if (d && d >= back && d <= t) ensure(p.category || 'other').spent += Number(p.amount) || 0;
    });

    // Upcoming bill / subscription occurrences (forward 30 days)
    const addOcc = (c, name, date, amount, kind) =>
      ensure(c).occ.push({ name, date, amount: Number(amount) || 0, kind });
    state.bills.forEach((it) => {
      occurrences(parseDate(it.date), it.cycle, !!it.recurring, t, fwd)
        .forEach((d) => addOcc(it.category || 'other', it.name || 'Bill', d, it.amount, 'bill'));
    });
    state.subscriptions.forEach((it) => {
      if (it.active === false) return;
      occurrences(parseDate(it.date), it.cycle, true, t, fwd)
        .forEach((d) => addOcc(it.category || 'other', it.name || 'Subscription', d, it.amount, 'sub'));
    });

    // Soft-mark each envelope: cover upcoming from what's left after spending
    Object.values(per).forEach((e) => {
      e.occ.sort((a, b) => a.date - b.date);
      e.upcomingTotal = e.occ.reduce((s, o) => s + o.amount, 0);
      let avail = Math.max(0, e.budgeted - e.spent);   // money still in the envelope
      e.occ.forEach((o) => {
        const cover = Math.min(avail, o.amount);
        o.covered = cover;
        o.pct = o.amount > 0 ? cover / o.amount : 1;
        avail -= cover;
      });
      e.earmarked = Math.max(0, e.budgeted - e.spent) - avail;  // = total covered
      e.free = Math.max(0, avail);
      e.shortfall = Math.max(0, e.upcomingTotal - Math.max(0, e.budgeted - e.spent));
      e.overspent = Math.max(0, e.spent - e.budgeted);
    });

    const onHand = Number(state.settings.startBalance) || 0;
    const assigned = Object.keys(budgets).reduce((s, c) => s + (Number(budgets[c]) || 0), 0);
    const list = Object.values(per);
    return {
      onHand, assigned, toAssign: onHand - assigned, per: list,
      totUpcoming: list.reduce((s, e) => s + e.upcomingTotal, 0),
      totCovered: list.reduce((s, e) => s + e.earmarked, 0)
    };
  }

  // Per-category trailing spend + upcoming total (used by the fund sheet)
  function catContext(c) {
    const { t, back, fwd } = windows();
    let spent = 0, up = 0;
    state.purchases.forEach((p) => {
      if ((p.category || 'other') === c) {
        const d = parseDate(p.date);
        if (d && d >= back && d <= t) spent += Number(p.amount) || 0;
      }
    });
    state.bills.forEach((it) => {
      if ((it.category || 'other') === c)
        up += occurrences(parseDate(it.date), it.cycle, !!it.recurring, t, fwd).length * (Number(it.amount) || 0);
    });
    state.subscriptions.forEach((it) => {
      if (it.active !== false && (it.category || 'other') === c)
        up += occurrences(parseDate(it.date), it.cycle, true, t, fwd).length * (Number(it.amount) || 0);
    });
    return { spent, up };
  }

  /* ====================================================================== */
  /*  RENDER                                                                 */
  /* ====================================================================== */
  const viewEl = document.getElementById('view');
  const navEl = document.getElementById('nav');

  const NAV = [
    { id: 'budget',        label: 'Budget',   icon: 'M12 3l9 5-9 5-9-5zM3 12l9 5 9-5M3 16.5l9 5 9-5' },
    { id: 'overview',      label: 'Forecast', icon: 'M3 13h2v6H3zm4-5h2v11H7zm4 3h2v8h-2zm4-6h2v14h-2z' },
    { id: 'income',        label: 'Income',   icon: 'M12 5v10m0-10l-4 4m4-4l4 4M5 19h14' },
    { id: 'bills',         label: 'Bills',    icon: 'M6 2h12v20l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6' },
    { id: 'subscriptions', label: 'Subs',     icon: 'M3 12a9 9 0 1 1 9 9M3 12v5m0-5h5' },
    { id: 'purchases',     label: 'Spend',    icon: 'M6 6h15l-1.5 9h-12zM6 6l-2-3M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2m8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2' }
  ];

  function renderNav() {
    navEl.innerHTML = NAV.map((n) => `
      <button data-tab="${n.id}" ${activeTab === n.id ? 'aria-current="page"' : ''} aria-label="${n.label}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${n.icon}"/></svg>
        <span>${n.label}</span>
      </button>`).join('');
  }

  function render() {
    renderNav();
    if (activeTab === 'budget') return renderBudget();
    if (activeTab === 'overview') return renderOverview();
    if (activeTab === 'income') return renderManager('income');
    if (activeTab === 'bills') return renderManager('bills');
    if (activeTab === 'subscriptions') return renderManager('subscriptions');
    if (activeTab === 'purchases') return renderManager('purchases');
  }

  /* ---- Overview --------------------------------------------------------- */
  function renderOverview() {
    const proj = buildProjection();
    const fig = monthFigures();
    const bud = computeBudget();
    const hasAnything = state.income.length || state.bills.length ||
      state.subscriptions.length || state.purchases.length;

    let html = '';

    // Balance hero + low-point callout
    html += `<section class="card">
      <div class="hero">
        <div>
          <div class="card-label">Balance on hand</div>
          <div class="bal-val money">${money(state.settings.startBalance)}</div>
        </div>
        <button class="edit-link" data-act="edit-balance">Adjust</button>
      </div>`;

    if (bud.toAssign > 0.005 || bud.toAssign < -0.005) {
      html += `<button class="assign-chip ${bud.toAssign < 0 ? 'over' : ''}" data-act="go-budget">
        <span class="money">${money(bud.toAssign)}</span>
        ${bud.toAssign < 0 ? 'assigned beyond your cash — rebalance' : 'still unassigned — give it a job'}</button>`;
    } else if (bud.assigned > 0) {
      html += `<button class="assign-chip ok" data-act="go-budget">Every dollar has a job ✓</button>`;
    }

    if (proj.events.length) {
      const lowAfterStart = proj.low.idx >= 0;
      html += `<div class="lowpoint">
        <span class="dot"></span>
        <span>Projected low point of <span class="money">${money(proj.low.bal)}</span>
        ${lowAfterStart ? 'around ' + fmtDay(proj.low.date).md : 'is your current balance'} ·
        ends near <span class="money">${money(proj.endBalance)}</span></span>
      </div>`;
    }
    html += `</section>`;

    // Signature: cashflow timeline
    html += `<section class="card">
      <div class="card-label" style="margin-bottom:6px">The month ahead · next ${HORIZON_DAYS} days</div>`;
    if (!proj.events.length) {
      html += `<div class="empty" style="padding:22px 6px">
        <div class="big">No scheduled movement yet</div>
        <p>Add income, bills or subscriptions and they'll line up here by predicted date.</p>
      </div>`;
    } else {
      html += `<div class="timeline">` + proj.events.map((ev, i) => {
        const f = fmtDay(ev.date);
        const low = i === proj.low.idx;
        return `<div class="tl-row ${ev.dir} ${low ? 'low' : ''}">
          <div class="tl-date">${f.wd}<b>${ev.date.getDate()}</b></div>
          <div class="tl-label">${esc(ev.label)}<small>${esc(ev.sub)}${low ? ' · <span class="tag">low</span>' : ''}</small></div>
          <div class="tl-right">
            <span class="amt ${ev.dir}">${signed(ev.dir === 'in' ? ev.amount : -ev.amount)}</span>
            <span class="run">${money(ev.running)}</span>
          </div>
        </div>`;
      }).join('') + `</div>`;
    }
    html += `</section>`;

    // Trailing summary
    html += `<div class="card-label" style="margin:18px 4px 10px">${fig.windowLabel}</div>`;
    html += `<div class="grid2">
      <div class="stat"><div class="k">Income</div><div class="v in">${money(fig.income)}</div></div>
      <div class="stat"><div class="k">Recurring out</div><div class="v out">${money(fig.recurringOut)}</div></div>
      <div class="stat"><div class="k">Purchases</div><div class="v out">${money(fig.purchases)}</div></div>
      <div class="stat"><div class="k">Items tracked</div><div class="v">${state.income.length + state.bills.length + state.subscriptions.length}</div></div>
      <div class="stat net">
        <div><div class="k">Net · 30 days</div></div>
        <div class="v ${fig.net >= 0 ? 'in' : 'out'}">${signed(fig.net)}</div>
      </div>
    </div>`;

    // Spend by category (canvas donut)
    const catEntries = Object.entries(fig.byCat).filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    if (catEntries.length) {
      html += `<section class="card">
        <div class="card-label" style="margin-bottom:12px">Where it went · ${fig.windowLabel.toLowerCase()}</div>
        <div class="donut-wrap">
          <canvas id="donut" width="232" height="232"></canvas>
          <div class="legend">${catEntries.map(([id, v]) => {
            const c = catById(id);
            return `<div class="row"><span class="sw" style="background:${c.color}"></span>
              <span class="nm">${esc(c.name)}</span><span class="vl">${money(v)}</span></div>`;
          }).join('')}</div>
        </div>
      </section>`;
    }

    if (!hasAnything) {
      html += `<div class="empty"><div class="big">A quiet ledger</div>
        <p>Start with an income source or a recurring bill — the timeline fills itself in from there.</p></div>`;
    }

    viewEl.innerHTML = html;
    if (catEntries.length) drawDonut(catEntries);
  }

  function drawDonut(entries) {
    const cv = document.getElementById('donut');
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const W = cv.width, cx = W / 2, cy = W / 2, R = W / 2 - 6, r = R * 0.58;
    ctx.clearRect(0, 0, W, W);
    const total = entries.reduce((t, [, v]) => t + v, 0) || 1;
    let a = -Math.PI / 2;
    entries.forEach(([id, v]) => {
      const slice = (v / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a, a + slice);
      ctx.closePath();
      ctx.fillStyle = catById(id).color;
      ctx.fill();
      a += slice;
    });
    // punch the hole
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---- Budget view (envelopes + soft-marked upcoming) ------------------- */
  function renderBudget() {
    const b = computeBudget();
    const envelopes = b.per.slice().sort((x, y) =>
      (y.budgeted - x.budgeted) || (x.cat).localeCompare(y.cat));

    // Flat list of upcoming payments across all envelopes, soonest first
    const upcoming = [];
    b.per.forEach((e) => e.occ.forEach((o) =>
      upcoming.push(Object.assign({ catId: e.cat }, o))));
    upcoming.sort((a, b2) => a.date - b2.date);

    let html = `<div class="view-head">
      <div><h2>Budget</h2><div class="sub">Give every dollar a job · rolling 30 days</div></div>
    </div>`;

    // To-assign hero
    const ta = b.toAssign;
    const cls = Math.abs(ta) < 0.005 ? 'zero' : (ta < 0 ? 'over' : 'left');
    const caption = Math.abs(ta) < 0.005
      ? (b.assigned > 0 ? 'Every dollar has a job' : 'Set your balance, then start assigning')
      : (ta < 0 ? 'Assigned beyond the cash you have' : 'Left to assign into envelopes');
    html += `<section class="card assign-hero">
      <div class="k">To assign</div>
      <div class="v ${cls}">${money(ta)}</div>
      <div class="ctx">On hand <span class="money">${money(b.onHand)}</span> ·
        assigned <span class="money">${money(b.assigned)}</span></div>
      <div class="ctx" style="margin-top:2px">${caption}</div>
      <button class="edit-link adjust" data-act="edit-balance">Adjust balance on hand</button>
    </section>`;

    // Layer 2 — soft-marked upcoming payments
    html += `<div class="card-label" style="margin:18px 4px 10px">Set aside for upcoming · next 30 days</div>`;
    if (!upcoming.length) {
      html += `<section class="card"><div class="empty" style="padding:18px 6px">
        <div class="big">Nothing due in the next 30 days</div>
        <p>Bills and subscriptions with a category will reserve their slice of that envelope here.</p>
      </div></section>`;
    } else {
      html += `<section class="card">` + upcoming.map((o) => {
        const c = catById(o.catId);
        const pct = Math.round((o.pct || 0) * 100);
        const full = pct >= 100;
        const f = fmtDay(o.date);
        return `<div class="up-row">
          <span class="up-dot" style="background:${c.color}"></span>
          <div class="up-main">
            <div class="nm">${esc(o.name)}</div>
            <div class="meta">${o.kind === 'sub' ? 'Renews' : 'Due'} ${f.md} · ${esc(c.name)}</div>
            <div class="bar ${full ? 'full' : ''}"><span style="width:${Math.min(100, pct)}%"></span></div>
          </div>
          <div class="up-right">
            <span class="pct ${full ? 'ok' : ''}">${pct}%</span>
            <span class="amt2">${money(o.covered)}/${money(o.amount)}</span>
          </div>
        </div>`;
      }).join('') + `</section>`;
    }

    // Layer 1 — envelopes
    html += `<div class="card-label" style="margin:18px 4px 10px">Envelopes</div>`;
    if (!envelopes.length) {
      html += `<section class="card"><div class="empty" style="padding:18px 6px">
        <div class="big">No envelopes yet</div>
        <p>Fund a category below to start telling your money where to go.</p>
      </div></section>`;
    } else {
      html += envelopes.map((e) => {
        const c = catById(e.cat);
        const base = Math.max(e.budgeted, e.spent + e.earmarked + e.free, 0.0001);
        const w = (n) => (Math.max(0, n) / base * 100).toFixed(1) + '%';
        let warn = '';
        if (e.overspent > 0) warn = `<div class="env-warn over">Over budget by ${money(e.overspent)}</div>`;
        else if (e.shortfall > 0) warn = `<div class="env-warn short">Needs ${money(e.shortfall)} more to cover what's upcoming</div>`;
        return `<div class="env" data-act="edit-budget" data-cat="${e.cat}">
          <div class="top">
            <div class="sw" style="background:${c.color}22;color:${c.color}">${esc(c.name[0])}</div>
            <div class="nm">${esc(c.name)}</div>
            <div class="bud">${money(e.budgeted)}</div>
            <span class="edit">Fund</span>
          </div>
          <div class="stack">
            <i class="s-spent" style="width:${w(e.spent)}"></i>
            <i class="s-mark"  style="width:${w(e.earmarked)}"></i>
            <i class="s-free"  style="width:${w(e.free)}"></i>
          </div>
          <div class="legend2">
            <span class="lg"><span class="d s-spent"></span>Spent <b>${money(e.spent)}</b></span>
            <span class="lg"><span class="d s-mark"></span>Set aside <b>${money(e.earmarked)}</b></span>
            <span class="lg"><span class="d s-free"></span>Free <b>${money(e.free)}</b></span>
          </div>
          ${warn}
        </div>`;
      }).join('');
    }

    // Fund another category
    const unbudgeted = CATS.filter((c) => !(Number((state.budgets || {})[c.id]) > 0));
    if (unbudgeted.length) {
      html += `<button class="add-env" data-act="add-budget">+ Fund another category</button>`;
    }

    viewEl.innerHTML = html;
  }

  /* ---- Manager views (income / bills / subscriptions / purchases) ------- */
  const META = {
    income:        { title: 'Income',        sub: 'Money in, by predicted date', noun: 'income source' },
    bills:         { title: 'Bills',         sub: 'One-off and recurring dues',   noun: 'bill' },
    subscriptions: { title: 'Subscriptions', sub: 'Recurring services',           noun: 'subscription' },
    purchases:     { title: 'Spending',      sub: 'Purchases by category',        noun: 'purchase' }
  };

  function renderManager(type) {
    const m = META[type];
    const list = state[type].slice();
    let html = `<div class="view-head">
      <div><h2>${m.title}</h2><div class="sub">${m.sub}</div></div>
      <button class="add-btn" data-act="add" data-type="${type}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>New
      </button>
    </div>`;

    if (!list.length) {
      html += `<div class="empty"><div class="big">No ${m.noun}s yet</div>
        <p>Tap <b>New</b> to add your first ${m.noun}. Everything stays on this device.</p></div>`;
      viewEl.innerHTML = html;
      return;
    }

    if (type === 'income') {
      list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      html += list.map((it) => itemRow(type, it, {
        swatch: ['↑', 'var(--in-soft)', 'var(--in)'],
        name: esc(it.source),
        meta: (it.recurring ? cycleName(it.cycle) + ' · next ' : 'Expected ') + fmtNice(it.date),
        amount: it.amount, dir: 'in'
      })).join('');
    } else if (type === 'bills') {
      list.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      html += list.map((it) => itemRow(type, it, {
        swatch: catSwatch(it.category),
        name: esc(it.name),
        meta: (it.recurring ? cycleName(it.cycle) : 'Due') + ' · ' + fmtNice(it.date) + catTag(it.category),
        amount: it.amount, dir: 'out'
      })).join('');
    } else if (type === 'subscriptions') {
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      const monthly = state.subscriptions.reduce((t, s) => {
        if (s.active === false) return t;
        const a = Number(s.amount) || 0;
        return t + (s.cycle === 'yearly' ? a / 12 : s.cycle === 'weekly' ? a * 52 / 12 : a);
      }, 0);
      html += `<div class="month-total"><span class="k">Roughly per month</span><span class="v out">${money(monthly)}</span></div>`;
      html += list.map((it) => itemRow(type, it, {
        swatch: catSwatch(it.category),
        name: esc(it.name) + (it.active === false ? ' <span class="pill">paused</span>' : ''),
        meta: 'Renews ' + fmtNice(it.date) + catTag(it.category),
        amount: it.amount, dir: 'out', cyc: cycleName(it.cycle),
        paused: it.active === false
      })).join('');
    } else { // purchases
      list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      const total = list.reduce((t, p) => t + (Number(p.amount) || 0), 0);
      html += `<div class="month-total"><span class="k">${list.length} purchase${list.length === 1 ? '' : 's'} logged</span><span class="v">${money(total)}</span></div>`;
      html += list.map((it) => itemRow(type, it, {
        swatch: catSwatch(it.category),
        name: esc(it.desc),
        meta: catById(it.category).name + ' · ' + fmtNice(it.date),
        amount: it.amount, dir: 'out'
      })).join('');
    }

    viewEl.innerHTML = html;
  }

  function fmtNice(iso) {
    const d = parseDate(iso);
    if (!d) return '—';
    return `${MO[d.getMonth()]} ${d.getDate()}`;
  }
  function catSwatch(catId) {
    const c = catById(catId);
    return [c.name[0], color2soft(c.color), c.color];
  }
  function color2soft(hex) { return hex + '22'; }   // 13% alpha tint
  function catTag(catId) { return catId ? ` · ${catById(catId).name}` : ''; }

  function itemRow(type, it, o) {
    return `<div class="item ${o.paused ? 'paused' : ''}" data-act="edit" data-type="${type}" data-id="${it.id}">
      <div class="swatch" style="background:${o.swatch[1]};color:${o.swatch[2]}">${esc(o.swatch[0])}</div>
      <div class="main">
        <div class="nm">${o.name}</div>
        <div class="meta">${esc(o.meta)}</div>
      </div>
      <div class="right">
        <span class="amt ${o.dir}">${money(o.amount)}</span>
        ${o.cyc ? `<span class="cyc">${esc(o.cyc)}</span>` : ''}
      </div>
    </div>`;
  }

  /* ====================================================================== */
  /*  EDITOR (bottom sheet)                                                  */
  /* ====================================================================== */
  const scrim = document.getElementById('scrim');
  const sheet = document.getElementById('sheet');

  function openSheet(html) {
    sheet.innerHTML = `<div class="grabber"></div>` + html;
    scrim.classList.add('open');
    requestAnimationFrame(() => sheet.classList.add('open'));
  }
  function closeSheet() {
    sheet.classList.remove('open');
    scrim.classList.remove('open');
    editing = null; draft = null; budgetEditing = null;
    setTimeout(() => { if (!sheet.classList.contains('open')) sheet.innerHTML = ''; }, 280);
  }
  scrim.addEventListener('click', closeSheet);

  function blank(type) {
    const t = toISO(today());
    if (type === 'income') return { source: '', amount: '', date: t, recurring: true, cycle: 'monthly' };
    if (type === 'bills') return { name: '', amount: '', date: t, recurring: true, cycle: 'monthly', category: 'utilities' };
    if (type === 'subscriptions') return { name: '', amount: '', date: t, cycle: 'monthly', category: 'entertainment', active: true };
    return { desc: '', amount: '', date: t, category: 'groceries' };
  }

  function openEditor(type, id) {
    editing = { type, id: id || null };
    draft = id ? structuredClone(state[type].find((x) => x.id === id)) : blank(type);
    renderEditor();
  }

  function catOptions(sel) {
    return CATS.map((c) => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${c.name}</option>`).join('');
  }
  function cycleOptions(sel) {
    return CYCLES.map((c) => `<option value="${c.id}" ${sel === c.id ? 'selected' : ''}>${c.name}</option>`).join('');
  }
  function amountField(val) {
    return `<div class="field amount">
      <label for="f-amount">Amount</label>
      <span class="cur">${esc(state.settings.currency || '')}</span>
      <input id="f-amount" data-k="amount" inputmode="decimal" placeholder="0.00" value="${esc(val)}" />
    </div>`;
  }

  function renderEditor() {
    const { type, id } = editing;
    const d = draft;
    const isEdit = !!id;
    const m = META[type];
    let fields = '';

    if (type === 'income') {
      fields = `
        <div class="field"><label for="f-source">Source</label>
          <input id="f-source" data-k="source" placeholder="Paycheck, freelance…" value="${esc(d.source)}" /></div>
        ${amountField(d.amount)}
        <div class="field"><label for="f-date">Predicted date</label>
          <input id="f-date" data-k="date" type="date" value="${esc(d.date)}" /></div>
        <div class="toggle-row"><span>Repeats</span>
          <label class="switch"><input type="checkbox" data-k="recurring" ${d.recurring ? 'checked' : ''}><span class="track"></span></label></div>
        <div class="field" data-when="recurring" style="${d.recurring ? '' : 'display:none'}">
          <label for="f-cycle">How often</label><select id="f-cycle" data-k="cycle">${cycleOptions(d.cycle)}</select></div>`;
    } else if (type === 'bills') {
      fields = `
        <div class="field"><label for="f-name">Name</label>
          <input id="f-name" data-k="name" placeholder="Electric, rent, insurance…" value="${esc(d.name)}" /></div>
        ${amountField(d.amount)}
        <div class="row2">
          <div class="field"><label for="f-date">Due date</label>
            <input id="f-date" data-k="date" type="date" value="${esc(d.date)}" /></div>
          <div class="field"><label for="f-category">Category</label>
            <select id="f-category" data-k="category">${catOptions(d.category)}</select></div>
        </div>
        <div class="toggle-row"><span>Repeats</span>
          <label class="switch"><input type="checkbox" data-k="recurring" ${d.recurring ? 'checked' : ''}><span class="track"></span></label></div>
        <div class="field" data-when="recurring" style="${d.recurring ? '' : 'display:none'}">
          <label for="f-cycle">How often</label><select id="f-cycle" data-k="cycle">${cycleOptions(d.cycle)}</select></div>`;
    } else if (type === 'subscriptions') {
      fields = `
        <div class="field"><label for="f-name">Name</label>
          <input id="f-name" data-k="name" placeholder="Streaming, cloud, gym…" value="${esc(d.name)}" /></div>
        ${amountField(d.amount)}
        <div class="row2">
          <div class="field"><label for="f-cycle">Billing cycle</label>
            <select id="f-cycle" data-k="cycle">${cycleOptions(d.cycle)}</select></div>
          <div class="field"><label for="f-date">Next renews</label>
            <input id="f-date" data-k="date" type="date" value="${esc(d.date)}" /></div>
        </div>
        <div class="field"><label for="f-category">Category</label>
          <select id="f-category" data-k="category">${catOptions(d.category)}</select></div>
        <div class="toggle-row"><span>Active</span>
          <label class="switch"><input type="checkbox" data-k="active" ${d.active !== false ? 'checked' : ''}><span class="track"></span></label></div>`;
    } else {
      fields = `
        <div class="field"><label for="f-desc">What for</label>
          <input id="f-desc" data-k="desc" placeholder="Coffee, groceries, parts…" value="${esc(d.desc)}" /></div>
        ${amountField(d.amount)}
        <div class="row2">
          <div class="field"><label for="f-date">Date</label>
            <input id="f-date" data-k="date" type="date" value="${esc(d.date)}" /></div>
          <div class="field"><label for="f-category">Category</label>
            <select id="f-category" data-k="category">${catOptions(d.category)}</select></div>
        </div>`;
    }

    openSheet(`
      <h3>${isEdit ? 'Edit' : 'New'} ${m.noun}</h3>
      ${fields}
      <div class="sheet-actions">
        ${isEdit ? '<button class="btn-danger" data-act="delete">Delete</button>' : ''}
        <button class="btn-primary" data-act="save">${isEdit ? 'Save changes' : 'Add ' + m.noun}</button>
      </div>`);
  }

  // Live-bind sheet inputs to the draft
  sheet.addEventListener('input', (e) => {
    const el = e.target.closest('[data-k]');
    if (!el || !draft) return;
    const k = el.dataset.k;
    draft[k] = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'recurring') {
      const dep = sheet.querySelector('[data-when="recurring"]');
      if (dep) dep.style.display = el.checked ? '' : 'none';
    }
  });

  function commit() {
    const { type, id } = editing;
    const d = draft;
    d.amount = Math.round((parseFloat(d.amount) || 0) * 100) / 100;
    // Minimal validation: need a label and a non-zero amount
    const label = d.source || d.name || d.desc || '';
    if (!label.trim()) { flashField('source name desc'); return; }
    if (!(d.amount > 0)) { flashField('amount'); return; }

    if (id) {
      const i = state[type].findIndex((x) => x.id === id);
      if (i >= 0) state[type][i] = Object.assign(state[type][i], d);
    } else {
      d.id = uid();
      state[type].push(d);
    }
    save();
    closeSheet();
    render();
  }
  function flashField(keys) {
    keys.split(' ').forEach((k) => {
      const el = sheet.querySelector(`[data-k="${k}"]`);
      if (el && el.offsetParent !== null) { el.focus(); el.style.outline = '2px solid var(--out)'; }
    });
  }
  function removeItem() {
    const { type, id } = editing;
    state[type] = state[type].filter((x) => x.id !== id);
    save(); closeSheet(); render();
  }

  /* ---- Settings sheet --------------------------------------------------- */
  function openSettings() {
    openSheet(`
      <h3>Settings</h3>
      <div class="row2">
        <div class="field"><label for="s-cur">Currency symbol</label>
          <input id="s-cur" maxlength="3" value="${esc(state.settings.currency)}" /></div>
        <div class="field amount"><label for="s-bal">Balance on hand</label>
          <span class="cur">${esc(state.settings.currency || '')}</span>
          <input id="s-bal" inputmode="decimal" value="${esc(state.settings.startBalance)}" /></div>
      </div>
      <div class="settings-list">
        <div class="srow"><span class="lk">Export data (JSON)</span><button class="link-btn" data-act="export">Download</button></div>
        <div class="srow"><span class="lk">Import data (JSON)</span><button class="link-btn" data-act="import">Choose file</button></div>
        <div class="srow"><span class="lk">Erase everything</span><button class="link-btn danger" data-act="wipe">Reset</button></div>
      </div>
      <div class="sheet-actions">
        <button class="btn-primary" data-act="save-settings">Save</button>
      </div>
      <p style="font-size:11.5px;color:var(--ink-faint);margin:14px 2px 2px;line-height:1.5">
        Everything is stored only on this device. Export now and then if you'd like a backup.</p>`);
  }
  function saveSettings() {
    const cur = sheet.querySelector('#s-cur').value.trim() || '$';
    const bal = parseFloat(sheet.querySelector('#s-bal').value) || 0;
    state.settings.currency = cur;
    state.settings.startBalance = Math.round(bal * 100) / 100;
    save(); closeSheet(); render();
  }
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'ledger-backup.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function importData() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = () => {
      const file = inp.files[0]; if (!file) return;
      const rdr = new FileReader();
      rdr.onload = () => {
        try {
          const data = JSON.parse(rdr.result);
          state = Object.assign(structuredClone(DEFAULT_STATE), data, {
            settings: Object.assign({}, DEFAULT_STATE.settings, data.settings)
          });
          save(); closeSheet(); render();
        } catch (e) { alert('That file could not be read as Ledger data.'); }
      };
      rdr.readAsText(file);
    };
    inp.click();
  }
  function wipe() {
    if (!confirm('Erase all income, bills, subscriptions and purchases on this device?')) return;
    state = structuredClone(DEFAULT_STATE);
    save(); closeSheet(); render();
  }

  /* ---- Adjust balance quick sheet (from overview) ----------------------- */
  function openBalance() {
    openSheet(`
      <h3>Balance on hand</h3>
      <div class="field amount">
        <label for="b-bal">How much is in the account right now</label>
        <span class="cur">${esc(state.settings.currency || '')}</span>
        <input id="b-bal" inputmode="decimal" value="${esc(state.settings.startBalance)}" />
      </div>
      <div class="sheet-actions"><button class="btn-primary" data-act="save-balance">Save</button></div>`);
    setTimeout(() => { const el = sheet.querySelector('#b-bal'); if (el) el.focus(); }, 60);
  }

  /* ---- Fund an envelope ------------------------------------------------- */
  function openBudgetEditor(catId) {
    budgetEditing = catId || null;     // null = choosing a new category
    renderBudgetEditor();
  }
  function renderBudgetEditor() {
    const adding = !budgetEditing;
    // In add mode, default to the first un-funded category
    if (adding) {
      const firstFree = CATS.find((c) => !(Number((state.budgets || {})[c.id]) > 0));
      budgetEditing = (firstFree || CATS[0]).id;
    }
    const cat = catById(budgetEditing);
    const current = Number((state.budgets || {})[budgetEditing]) || 0;
    const ctx = catContext(budgetEditing);
    const suggested = Math.round((ctx.spent + ctx.up) * 100) / 100;

    const picker = adding ? `
      <div class="field"><label for="bud-cat">Category</label>
        <select id="bud-cat" data-budcat>${CATS.map((c) =>
          `<option value="${c.id}" ${c.id === budgetEditing ? 'selected' : ''}>${c.name}</option>`).join('')}</select></div>` : '';

    openSheet(`
      <h3>Fund ${esc(cat.name)}</h3>
      ${picker}
      <div class="field amount">
        <label for="bud-amt">Amount in this envelope</label>
        <span class="cur">${esc(state.settings.currency || '')}</span>
        <input id="bud-amt" inputmode="decimal" value="${current ? esc(current) : ''}" placeholder="0.00" />
      </div>
      <div class="ctx" style="font-size:12.5px;color:var(--ink-soft);margin:-4px 2px 12px">
        Last 30 days spent <span class="money">${money(ctx.spent)}</span> ·
        upcoming <span class="money">${money(ctx.up)}</span>${ctx.up > 0
          ? ` — fund at least <span class="money">${money(suggested)}</span> to cover it` : ''}
      </div>
      ${ctx.up > 0 ? `<button class="btn-ghost" style="width:100%;margin-bottom:12px" data-act="cover-upcoming" data-v="${suggested}">Cover upcoming (${money(suggested)})</button>` : ''}
      <div class="sheet-actions">
        ${current ? '<button class="btn-danger" data-act="clear-budget">Remove</button>' : ''}
        <button class="btn-primary" data-act="save-budget">Save</button>
      </div>`);
  }
  function saveBudget() {
    const amt = Math.round((parseFloat(sheet.querySelector('#bud-amt').value) || 0) * 100) / 100;
    if (!state.budgets) state.budgets = {};
    if (amt > 0) state.budgets[budgetEditing] = amt;
    else delete state.budgets[budgetEditing];
    save(); budgetEditing = null; closeSheet(); render();
  }

  /* ====================================================================== */
  /*  EVENTS                                                                 */
  /* ====================================================================== */
  navEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    activeTab = b.dataset.tab;
    viewEl.scrollTop = 0;
    window.scrollTo(0, 0);
    render();
  });

  document.getElementById('settingsBtn').addEventListener('click', openSettings);

  viewEl.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'add') openEditor(t.dataset.type);
    else if (act === 'edit') openEditor(t.dataset.type, t.dataset.id);
    else if (act === 'edit-balance') openBalance();
    else if (act === 'go-budget') { activeTab = 'budget'; window.scrollTo(0, 0); render(); }
    else if (act === 'edit-budget') openBudgetEditor(t.dataset.cat);
    else if (act === 'add-budget') openBudgetEditor(null);
  });

  sheet.addEventListener('click', (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    if (act === 'save') commit();
    else if (act === 'delete') removeItem();
    else if (act === 'save-settings') saveSettings();
    else if (act === 'save-balance') {
      const v = parseFloat(sheet.querySelector('#b-bal').value) || 0;
      state.settings.startBalance = Math.round(v * 100) / 100;
      save(); closeSheet(); render();
    }
    else if (act === 'export') exportData();
    else if (act === 'import') importData();
    else if (act === 'wipe') wipe();
    else if (act === 'save-budget') saveBudget();
    else if (act === 'clear-budget') { delete (state.budgets || {})[budgetEditing]; save(); budgetEditing = null; closeSheet(); render(); }
    else if (act === 'cover-upcoming') {
      const inp = sheet.querySelector('#bud-amt');
      if (inp) inp.value = t.dataset.v;
    }
  });

  // Category switch inside the fund sheet → re-render with that category's context
  sheet.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-budcat]');
    if (!sel) return;
    budgetEditing = sel.value;
    renderBudgetEditor();
  });

  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

  /* ---- Service worker (offline). Needs https or localhost, not file:// -- */
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  /* ---- Go ---------------------------------------------------------------- */
  render();
})();
