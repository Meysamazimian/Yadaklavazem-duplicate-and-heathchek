(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var fmtNum = new Intl.NumberFormat('fa-IR');
  var fmtPct = function (v) { return v === null || v === undefined ? '—' : fmtNum.format(Math.round(v * 1000) / 10) + '٪'; };
  var dateFmt = new Intl.DateTimeFormat('fa-IR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Tehran' });
  var hourFmt = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tehran' });
  var fmtDate = function (iso) { return iso ? dateFmt.format(new Date(iso)) : '—'; };
  var n = function (v) { return v === null || v === undefined ? '—' : fmtNum.format(v); };

  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ago(iso) {
    if (!iso) return '—';
    var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return n(s) + ' ثانیه پیش';
    if (s < 3600) return n(Math.round(s / 60)) + ' دقیقه پیش';
    if (s < 86400) return n(Math.round(s / 3600)) + ' ساعت پیش';
    return n(Math.round(s / 86400)) + ' روز پیش';
  }
  function dur(ms) { return ms === null || ms === undefined ? '—' : ms < 1000 ? n(ms) + ' ms' : n(Math.round(ms / 100) / 10) + ' s'; }
  function badge(cls, text) { return '<span class="badge ' + cls + '">' + esc(text) + '</span>'; }
  function api(path) {
    return fetch('/api' + path, { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('unauthenticated'); }
      return r.json();
    });
  }

  // ---------- charts (inline SVG) ----------
  function latencyChart(hourly) {
    if (!hourly.length) return '<p class="muted">هنوز داده‌ای ثبت نشده است.</p>';
    var W = 560, H = 190, P = { l: 40, r: 10, t: 10, b: 24 };
    var max = Math.max.apply(null, hourly.map(function (h) { return h.max; }).concat([50]));
    var x = function (i) { return P.l + (hourly.length === 1 ? (W - P.l - P.r) / 2 : i * (W - P.l - P.r) / (hourly.length - 1)); };
    // RTL page: newest on the left would confuse; keep time flowing left to right inside the chart.
    var y = function (v) { return P.t + (H - P.t - P.b) * (1 - v / max); };
    var line = function (key) { return hourly.map(function (h, i) { return (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(h[key]).toFixed(1); }).join(' '); };
    var grid = [0, 0.5, 1].map(function (f) { var v = max * f; return '<line x1="' + P.l + '" x2="' + (W - P.r) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="currentColor" opacity=".12"/><text x="' + (P.l - 4) + '" y="' + (y(v) + 3) + '" text-anchor="end">' + Math.round(v) + '</text>'; }).join('');
    var labels = hourly.map(function (h, i) { return i % Math.ceil(hourly.length / 6) === 0 ? '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + hourFmt.format(new Date(h.t)) + '</text>' : ''; }).join('');
    var bad = hourly.map(function (h, i) { return h.ok < h.total ? '<circle cx="' + x(i) + '" cy="' + (H - P.b) + '" r="3.5" fill="#dc2626"><title>' + (h.total - h.ok) + ' خطا</title></circle>' : ''; }).join('');
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="نمودار تأخیر ساعتی" style="direction:ltr">' + grid + labels +
      '<path d="' + line('max') + '" fill="none" stroke="#f59e0b" stroke-width="1.5" stroke-dasharray="4 3"/>' +
      '<path d="' + line('avg') + '" fill="none" stroke="#2563eb" stroke-width="2"/>' + bad + '</svg>' +
      '<div class="legend"><span><i class="dot" style="background:#2563eb"></i>میانگین (ms)</span><span><i class="dot" style="background:#f59e0b"></i>بیشینه (ms)</span><span><i class="dot" style="background:#dc2626"></i>ساعت دارای خطا</span></div>';
  }
  function spark(values, w, h) {
    if (!values || values.length < 2) return '<span class="muted">—</span>';
    var abs = values.map(Math.abs), max = Math.max.apply(null, abs.concat([1]));
    var step = w / (values.length - 1);
    var pts = values.map(function (v, i) { return (i * step).toFixed(1) + ',' + (h - 2 - (h - 4) * Math.abs(v) / max).toFixed(1); }).join(' ');
    var fails = values.map(function (v, i) { return v < 0 ? '<circle cx="' + (i * step).toFixed(1) + '" cy="' + (h - 2) + '" r="2.2" fill="#dc2626"/>' : ''; }).join('');
    return '<svg width="' + w + '" height="' + h + '" style="direction:ltr;vertical-align:middle"><polyline points="' + pts + '" fill="none" stroke="#2563eb" stroke-width="1.4"/>' + fails + '</svg>';
  }

  // ---------- tabs ----------
  var state = { tab: 'overview', endpoints: [], filter: '', onlyBad: false };
  var tabs = document.getElementById('tabs');
  tabs.addEventListener('click', function (e) {
    var t = e.target.getAttribute && e.target.getAttribute('data-tab');
    if (!t) return;
    state.tab = t;
    [].forEach.call(tabs.children, function (b) { b.classList.toggle('active', b === e.target); });
    ['overview', 'endpoints', 'replication', 'events'].forEach(function (id) { document.getElementById('tab-' + id).hidden = id !== t; });
    load();
  });

  function stat(label, value, sub, cls) {
    return '<div class="card stat"><div class="label">' + label + '</div><div class="value ' + (cls || '') + '">' + value + '</div><div class="sub">' + (sub || '') + '</div></div>';
  }

  // ---------- overview ----------
  function renderOverview(s) {
    var m = s.monitoring, r = s.replication, run = r.lastRun;
    var health = m.down > 0 ? badge('bad', n(m.down) + ' اندپوینت خراب') : m.endpoints === 0 ? badge('mute', 'بدون داده') : badge('ok', 'همه سالم');
    var runBadge = !run ? badge('mute', 'هنوز اجرا نشده') : run.status === 'ok' ? badge('ok', 'موفق') : run.status === 'running' ? badge('warn', 'در حال اجرا') : run.status === 'partial' ? badge('warn', 'ناقص') : badge('bad', 'ناموفق');
    var lagCls = r.lagSeconds !== null && r.lagSeconds > s.config.intervalMinutes * 60 * 3 ? 'bad' : '';
    var html = '<div class="grid">' +
      stat('وضعیت سرویس', health, 'آدرس: <span class="ltr">' + esc(s.config.backendUrl) + '</span>') +
      stat('آپتایم ۲۴ ساعت', fmtPct(m.uptime24h), n(m.up) + ' سالم از ' + n(m.endpoints) + ' اندپوینت') +
      stat('میانگین تأخیر', m.avgLatencyMs === null ? '—' : n(m.avgLatencyMs) + ' ms', 'بیشینه: ' + (m.maxLatencyMs === null ? '—' : n(m.maxLatencyMs) + ' ms')) +
      stat('آخرین دوپلیکیت', runBadge, run ? ago(run.startedAt) + ' · ' + n(run.rowsCopied) + ' ردیف جدید' : '') +
      stat('فاصله از منبع (lag)', r.lagSeconds === null ? '—' : ago(r.lastSuccessAt), 'ردیف عقب‌مانده: ' + n(r.rowsBehind), lagCls) +
      stat('کل ردیف کپی‌شده', n(r.totalRowsCopied), n(r.tables) + ' جدول' + (r.tablesFailing ? ' · ' + n(r.tablesFailing) + ' جدول با خطا' : '')) +
      '</div>' +
      '<div class="two"><div class="card"><h2>تأخیر در ۲۴ ساعت گذشته</h2>' + latencyChart(m.hourly) + '</div>' +
      '<div class="card"><h2>چرخه‌ی زمان‌بندی</h2><table><tbody>' +
      '<tr><td>فاصله‌ی چرخه</td><td>' + n(s.config.intervalMinutes) + ' دقیقه</td></tr>' +
      '<tr><td>زمان‌بند داخلی</td><td>' + (s.config.scheduler ? badge('ok', 'روشن') : badge('mute', 'خاموش')) + '</td></tr>' +
      '<tr><td>هیت کرون (/cron/run)</td><td>' + (s.config.cronEnabled ? badge('ok', 'فعال') : badge('mute', 'غیرفعال')) + '</td></tr>' +
      '<tr><td>آخرین شروع</td><td>' + fmtDate(s.cycle.lastStartedAt) + '</td></tr>' +
      '<tr><td>آخرین پایان</td><td>' + fmtDate(s.cycle.lastFinishedAt) + '</td></tr>' +
      '<tr><td>اجرای بعدی (تقریبی)</td><td>' + fmtDate(s.cycle.nextExpectedAt) + '</td></tr>' +
      '</tbody></table></div></div>';
    document.getElementById('tab-overview').innerHTML = html;
  }

  // ---------- endpoints ----------
  function renderEndpoints() {
    var rows = state.endpoints.filter(function (e) {
      if (state.onlyBad && e.lastOk !== false && !e.isDown) return false;
      return !state.filter || e.key.toLowerCase().indexOf(state.filter.toLowerCase()) >= 0;
    });
    var body = rows.map(function (e) {
      var st = e.lastOk === null ? badge('mute', 'نامشخص') : e.isDown ? badge('bad', 'قطع') : e.lastOk ? badge('ok', 'سالم') : badge('warn', 'خطای گذرا');
      return '<tr class="click" data-key="' + esc(e.key) + '"><td>' + st + '</td><td class="ltr">' + esc(e.key) + '</td><td>' + esc(e.auth || '—') + '</td><td>' + (e.lastStatus === null ? '—' : n(e.lastStatus)) + '</td><td>' + dur(e.lastLatencyMs) + '</td><td>' + fmtPct(e.uptime24h) + '</td><td>' + spark(e.spark, 90, 22) + '</td><td class="muted">' + ago(e.lastCheckedAt) + '</td></tr>';
    }).join('');
    var host = document.getElementById('tab-endpoints');
    var keep = host.querySelector('input[type=search]') === document.activeElement;
    host.innerHTML = '<div class="toolbar"><input type="search" id="ep-filter" placeholder="جستجوی مسیر…" value="' + esc(state.filter) + '"><label><input type="checkbox" id="ep-bad"' + (state.onlyBad ? ' checked' : '') + '> فقط خراب‌ها</label><span class="muted">' + n(rows.length) + ' از ' + n(state.endpoints.length) + '</span></div>' +
      '<div class="card"><table><thead><tr><th>وضعیت</th><th>اندپوینت</th><th>احراز هویت</th><th>کد</th><th>تأخیر</th><th>آپتایم ۲۴س</th><th>۳ ساعت اخیر</th><th>آخرین بررسی</th></tr></thead><tbody>' + (body || '<tr><td colspan="8" class="muted">موردی نیست.</td></tr>') + '</tbody></table></div>' +
      '<p class="muted">کد ۴۰۱/۴۰۳ برای مسیرهای نیازمند ورود طبیعی است؛ فقط خطای ۵xx، تایم‌اوت و قطع اتصال «خراب» حساب می‌شود.</p>';
    if (keep) { var f = document.getElementById('ep-filter'); f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
  }
  document.getElementById('tab-endpoints').addEventListener('input', function (e) {
    if (e.target.id === 'ep-filter') { state.filter = e.target.value; renderEndpoints(); }
  });
  document.getElementById('tab-endpoints').addEventListener('change', function (e) {
    if (e.target.id === 'ep-bad') { state.onlyBad = e.target.checked; renderEndpoints(); }
  });
  document.getElementById('tab-endpoints').addEventListener('click', function (e) {
    var tr = e.target.closest && e.target.closest('tr[data-key]');
    if (tr) openEndpoint(tr.getAttribute('data-key'));
  });
  function openEndpoint(key) {
    api('/endpoints/history?hours=24&key=' + encodeURIComponent(key)).then(function (rows) {
      var vals = rows.map(function (r) { return r.ok ? r.latencyMs : -r.latencyMs; });
      var fails = rows.filter(function (r) { return !r.ok; }).slice(-15).reverse();
      document.getElementById('detail-body').innerHTML = '<h2 class="ltr">' + esc(key) + '</h2><p class="muted">۲۴ ساعت گذشته · ' + n(rows.length) + ' بررسی</p>' +
        '<div class="card">' + spark(vals, 700, 80) + '</div><h2 style="margin-top:14px">آخرین خطاها</h2>' +
        (fails.length ? '<table><tbody>' + fails.map(function (r) { return '<tr><td>' + fmtDate(r.at) + '</td><td>' + (r.status === null ? '—' : n(r.status)) + '</td><td class="wrap ltr">' + esc(r.error) + '</td></tr>'; }).join('') + '</tbody></table>' : '<p class="muted">خطایی ثبت نشده.</p>');
      document.getElementById('detail').showModal();
    });
  }

  // ---------- replication ----------
  function renderReplication(runs, tables) {
    var runRows = runs.map(function (r) {
      var st = r.status === 'ok' ? badge('ok', 'موفق') : r.status === 'running' ? badge('warn', 'در حال اجرا') : r.status === 'partial' ? badge('warn', 'ناقص') : badge('bad', 'ناموفق');
      return '<tr class="click" data-run="' + r.id + '"><td>' + st + '</td><td>' + fmtDate(r.startedAt) + '</td><td>' + dur(r.durationMs) + '</td><td>' + n(r.rowsCopied) + '</td><td>' + n(r.tablesWithRows) + '/' + n(r.tablesTotal) + '</td><td>' + (r.tablesFailed ? badge('bad', n(r.tablesFailed)) : '0') + '</td><td>' + n(r.rowsBehind) + '</td><td class="muted">' + esc(r.trigger) + '</td><td class="wrap ltr">' + esc(r.error) + '</td></tr>';
    }).join('');
    var tblRows = tables.map(function (t) {
      var diff = t.srcRows !== null && t.dstRows !== null ? t.srcRows - t.dstRows : null;
      var st = t.lastError ? badge('bad', 'خطا') : t.skippedReason ? badge('mute', 'ردشده') : diff > 0 ? badge('warn', n(diff) + ' عقب') : badge('ok', 'همگام');
      return '<tr><td>' + st + '</td><td class="ltr">' + esc(t.table) + '</td><td class="muted">' + esc(t.mode || '—') + '</td><td>' + n(t.srcRows) + '</td><td>' + n(t.dstRows) + '</td><td>' + n(t.totalCopied) + '</td><td class="muted">' + ago(t.lastSuccessAt) + '</td><td class="wrap">' + esc(t.lastError || t.skippedReason || '') + '</td></tr>';
    }).join('');
    document.getElementById('tab-replication').innerHTML =
      '<div class="card"><h2>اجراهای اخیر دوپلیکیت</h2><table><thead><tr><th>وضعیت</th><th>شروع</th><th>مدت</th><th>ردیف جدید</th><th>جدول‌های دارای ردیف</th><th>خطا</th><th>عقب‌مانده</th><th>راه‌انداز</th><th>پیام</th></tr></thead><tbody>' + (runRows || '<tr><td colspan="9" class="muted">هنوز اجرایی ثبت نشده.</td></tr>') + '</tbody></table></div>' +
      '<div class="card" style="margin-top:12px"><h2>جدول‌ها</h2><table><thead><tr><th>وضعیت</th><th>جدول</th><th>روش</th><th>منبع</th><th>کپی</th><th>کل کپی‌شده</th><th>آخرین موفقیت</th><th>توضیح</th></tr></thead><tbody>' + (tblRows || '<tr><td colspan="8" class="muted">—</td></tr>') + '</tbody></table></div>' +
      '<p class="muted">دوپلیکیت فقط اضافه می‌کند: ردیف تازه کپی می‌شود، چیزی حذف یا بازنویسی نمی‌شود (تغییر ردیف‌های قدیمی در منبع به کپی منتقل نمی‌شود).</p>';
  }
  document.getElementById('tab-replication').addEventListener('click', function (e) {
    var tr = e.target.closest && e.target.closest('tr[data-run]');
    if (!tr) return;
    api('/replication/runs/' + tr.getAttribute('data-run') + '/tables').then(function (rows) {
      document.getElementById('detail-body').innerHTML = '<h2>جدول‌های اجرای ' + n(Number(tr.getAttribute('data-run'))) + '</h2>' +
        (rows.length ? '<table><thead><tr><th>جدول</th><th>ردیف جدید</th><th>مدت</th><th>توضیح</th></tr></thead><tbody>' + rows.map(function (r) { return '<tr><td class="ltr">' + esc(r.table) + (r.createdTable ? ' ' + badge('ok', 'جدول ساخته شد') : '') + '</td><td>' + n(r.copied) + '</td><td>' + dur(r.durationMs) + '</td><td class="wrap">' + esc(r.error || '') + '</td></tr>'; }).join('') + '</tbody></table>' : '<p class="muted">در این اجرا ردیف جدیدی نبود.</p>');
      document.getElementById('detail').showModal();
    });
  });

  // ---------- events ----------
  function renderEvents(rows) {
    var lvl = { error: badge('bad', 'خطا'), warn: badge('warn', 'هشدار'), info: badge('ok', 'اطلاع') };
    document.getElementById('tab-events').innerHTML = '<div class="card"><table><thead><tr><th>زمان</th><th>سطح</th><th>نوع</th><th>موضوع</th><th>پیام</th></tr></thead><tbody>' +
      (rows.map(function (r) { return '<tr><td>' + fmtDate(r.at) + '</td><td>' + (lvl[r.level] || esc(r.level)) + '</td><td class="muted">' + esc(r.type) + '</td><td class="ltr">' + esc(r.subject || '') + '</td><td class="wrap">' + esc(r.message || '') + '</td></tr>'; }).join('') || '<tr><td colspan="5" class="muted">رویدادی ثبت نشده.</td></tr>') + '</tbody></table></div>';
  }

  // ---------- loading ----------
  function load() {
    var p;
    if (state.tab === 'overview') p = api('/summary').then(renderOverview);
    else if (state.tab === 'endpoints') p = api('/endpoints').then(function (r) { state.endpoints = r; renderEndpoints(); });
    else if (state.tab === 'replication') p = Promise.all([api('/replication/runs?limit=40'), api('/replication/tables')]).then(function (r) { renderReplication(r[0], r[1]); });
    else p = api('/events?limit=150').then(renderEvents);
    p.then(function () { document.getElementById('updated').textContent = 'به‌روزرسانی: ' + hourFmt.format(new Date()); }).catch(function () {});
  }

  document.getElementById('run-now').addEventListener('click', function () {
    var b = this; b.disabled = true;
    fetch('/api/run', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'dashboard' } })
      .then(function () { setTimeout(function () { b.disabled = false; load(); }, 4000); })
      .catch(function () { b.disabled = false; });
  });

  load();
  setInterval(function () { if (!document.hidden && !document.getElementById('detail').open && !(document.activeElement && document.activeElement.tagName === 'INPUT')) load(); }, 30000);
})();
