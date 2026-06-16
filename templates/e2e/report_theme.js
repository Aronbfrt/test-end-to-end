/* report_theme.js — full custom dashboard rendered from pytest-html's own data-jsonblob.
 *
 * Why a full custom renderer instead of CSS/DOM patches on #results-table: pytest-html
 * rebuilds that whole table from scratch (table.replaceWith(newTable)) on every filter
 * checkbox click and every sort — any row/group we injected into it gets wiped out a
 * second later. Reading the same JSON blob and rendering our own view sidesteps that
 * entirely: our dashboard owns its own DOM and never gets replaced.
 *
 * The original table is kept in the DOM (hidden) as a no-JS fallback / "vue brute" escape
 * hatch — never deleted, just display:none'd.
 */
(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function textOfHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    return tmp.textContent.trim();
  }

  const RESULT_ORDER = { Error: 0, Failed: 1, Rerun: 2, XFailed: 3, XPassed: 4, Skipped: 5, Passed: 6 };
  const RESULT_ICON = { Passed: '✓', Failed: '✗', Error: '⚠', Skipped: '–', Rerun: '↻', XFailed: '✗', XPassed: '✓' };

  function parseData() {
    const el = document.getElementById('data-container');
    if (!el) return null;
    try {
      return JSON.parse(el.dataset.jsonblob);
    } catch (e) {
      return null;
    }
  }

  function buildModel(data) {
    const tests = [];
    Object.entries(data.tests).forEach(([testId, runs]) => {
      // pytest-rerunfailures: keep only the LAST attempt as the test's real outcome,
      // but remember if it ever rerun (shown as a small badge, not as a separate row).
      const last = runs[runs.length - 1];
      const everRerun = runs.length > 1;
      const cells = last.resultsTableRow.map(textOfHtml);
      const catHtml = last.resultsTableRow[2] || '';
      const category = textOfHtml(catHtml) || '-';
      // (not classOfHtml(catHtml) — a bare <td> assigned via innerHTML on a <div> gets
      // dropped by the HTML parser outside a <table> context, so the class is lost even
      // though the text survives; comparing the already-extracted text is simpler AND correct)
      const isSecurity = category.toLowerCase() === 'security';
      const parts = testId.split('::')[0].split('/'); // "tests/seo/test_seo.py" -> ["tests","seo","test_seo.py"]
      const domain = parts.length > 2 ? parts[1] : 'autre';
      const images = (last.extras || []).filter((e) => e.format_type === 'image').map((e) => e.path || e.content);
      tests.push({
        testId,
        domain,
        result: last.result,
        category,
        isSecurity,
        duration: cells[3] || '',
        log: last.log || '',
        images,
        everRerun,
      });
    });
    tests.sort((a, b) => (RESULT_ORDER[a.result] ?? 9) - (RESULT_ORDER[b.result] ?? 9));

    const domains = {};
    tests.forEach((t) => {
      (domains[t.domain] = domains[t.domain] || []).push(t);
    });
    return { tests, domains };
  }

  function counts(tests) {
    const c = { Passed: 0, Failed: 0, Error: 0, Skipped: 0, Rerun: 0, XFailed: 0, XPassed: 0 };
    tests.forEach((t) => { c[t.result] = (c[t.result] || 0) + 1; });
    return c;
  }

  function statCard(key, label, value) {
    return `<div class="tee-stat tee-stat--${key.toLowerCase()}">
      <span class="tee-stat__icon">${RESULT_ICON[key] || '•'}</span>
      <span class="tee-stat__value">${value}</span>
      <span class="tee-stat__label">${label}</span>
    </div>`;
  }

  function renderHero(data, model) {
    const c = counts(model.tests);
    const total = model.tests.length;
    const securityFails = model.tests.filter((t) => t.isSecurity && (t.result === 'Failed' || t.result === 'Error')).length;
    const env = data.environment || {};
    const chips = Object.keys(env).slice(0, 4).map((k) => `<span class="tee-chip">${escapeHtml(k)}: ${escapeHtml(JSON.stringify(env[k]).slice(0, 40))}</span>`).join('');

    return `
    <header class="tee-hero">
      <div class="tee-hero__top">
        <div>
          <div class="tee-hero__title">${escapeHtml(data.title || 'Test End-to-End')}</div>
          <div class="tee-hero__sub">${total} tests · ${Object.keys(model.domains).length} domaines</div>
        </div>
        ${securityFails > 0 ? `<div class="tee-alert">🔒 ${securityFails} alerte${securityFails > 1 ? 's' : ''} sécurité</div>` : ''}
      </div>
      <div class="tee-stats">
        ${statCard('Passed', 'Réussis', c.Passed + c.XPassed)}
        ${statCard('Failed', 'Échoués', c.Failed + c.Error)}
        ${statCard('Skipped', 'Ignorés', c.Skipped + c.XFailed)}
        ${statCard('Rerun', 'Relances', c.Rerun)}
      </div>
      <div class="tee-envrow">${chips}</div>
    </header>`;
  }

  function renderToolbar(model) {
    const cats = new Set();
    model.tests.forEach((t) => cats.add(t.category));
    const pills = ['<button class="tee-pill is-active" data-cat="">Toutes</button>']
      .concat(Array.from(cats).filter((c) => c && c !== '-').sort().map((c) => `<button class="tee-pill" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`))
      .join('');
    return `
    <div class="tee-toolbar">
      <input type="search" class="tee-search" placeholder="Rechercher un test…">
      <div class="tee-pillbar">${pills}</div>
      <div class="tee-resultbar">
        ${['Passed', 'Failed', 'Skipped', 'Rerun'].map((r) => `<label class="tee-resultpill tee-resultpill--${r.toLowerCase()}"><input type="checkbox" checked data-result="${r}"> ${r === 'Passed' ? 'Réussis' : r === 'Failed' ? 'Échoués' : r === 'Skipped' ? 'Ignorés' : 'Relances'}</label>`).join('')}
      </div>
    </div>`;
  }

  function renderTestRow(t) {
    const resultClass = t.result.toLowerCase();
    const img = t.images[0] ? `<div class="tee-row__media"><img src="${escapeHtml(t.images[0])}" loading="lazy" alt="screenshot"></div>` : '';
    const log = t.log ? `<pre class="tee-row__log">${escapeHtml(t.log)}</pre>` : '';
    const shortName = t.testId.split('::').slice(1).join(' › ') || t.testId;
    const isBroken = t.result === 'Failed' || t.result === 'Error';
    // A static HTML file can't execute pytest itself — no backend to run the command. The
    // honest, actually-useful version of "relancer" is: copy the exact command, paste it in
    // a terminal. That's a real action a button can perform, unlike pretending to re-run.
    const rerunBtn = isBroken
      ? `<button type="button" class="tee-rerun-btn" data-cmd="pytest &quot;${escapeHtml(t.testId)}&quot; -v"
           title="Un rapport HTML statique ne peut pas exécuter de code — copie la commande et colle-la dans ton terminal pour relancer ce test précis.">
           🔁 Copier la commande pour relancer ce test
         </button>`
      : '';
    return `
    <div class="tee-row tee-row--${resultClass}" data-result="${t.result}" data-category="${escapeHtml(t.category)}" data-search="${escapeHtml(t.testId.toLowerCase())}">
      <div class="tee-row__head" tabindex="0">
        <span class="tee-row__icon">${RESULT_ICON[t.result] || '•'}</span>
        <span class="tee-row__name">${escapeHtml(shortName)}</span>
        ${t.category && t.category !== '-' ? `<span class="tee-chip tee-chip--cat ${t.isSecurity ? 'tee-chip--security' : ''}">${t.isSecurity ? '🔒 ' : ''}${escapeHtml(t.category)}</span>` : ''}
        ${t.everRerun ? '<span class="tee-chip tee-chip--rerun">↻ relancé</span>' : ''}
        <span class="tee-row__duration">${escapeHtml(t.duration)}</span>
        <span class="tee-row__chevron">▾</span>
      </div>
      <div class="tee-row__detail">
        ${rerunBtn}
        ${log}
        ${img}
        ${!log && !img ? '<div class="tee-row__empty">Aucun détail supplémentaire.</div>' : ''}
      </div>
    </div>`;
  }

  function renderGroup(domain, tests) {
    const c = counts(tests);
    const broken = c.Failed + c.Error;
    return `
    <section class="tee-group ${broken ? 'is-open' : ''}" data-domain="${escapeHtml(domain)}">
      <div class="tee-group__head" tabindex="0">
        <span class="tee-group__chevron">▾</span>
        <span class="tee-group__name">${escapeHtml(domain)}</span>
        <span class="tee-group__count">${tests.length} test${tests.length > 1 ? 's' : ''}</span>
        ${broken ? `<span class="tee-chip tee-chip--fail">${broken} échec${broken > 1 ? 's' : ''}</span>` : '<span class="tee-chip tee-chip--ok">OK</span>'}
      </div>
      <div class="tee-group__body">
        ${tests.map(renderTestRow).join('')}
      </div>
    </section>`;
  }

  function renderDashboard(data, model) {
    const root = document.createElement('div');
    root.className = 'tee-root';
    root.innerHTML = renderHero(data, model) + renderToolbar(model) +
      `<div class="tee-groups">${Object.entries(model.domains).map(([d, t]) => renderGroup(d, t)).join('')}</div>` +
      `<div class="tee-empty-state" hidden>Aucun test ne correspond aux filtres.</div>`;
    return root;
  }

  function wireInteractions(root) {
    // group collapse
    root.querySelectorAll('.tee-group__head').forEach((head) => {
      head.addEventListener('click', () => head.closest('.tee-group').classList.toggle('is-open'));
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } });
    });
    // row detail toggle
    root.querySelectorAll('.tee-row__head').forEach((head) => {
      head.addEventListener('click', () => head.closest('.tee-row').classList.toggle('is-expanded'));
      head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); } });
    });

    // "relancer" button — copies the exact pytest command to the clipboard. A static HTML
    // file genuinely cannot execute that command itself (no backend); this is the honest
    // version of "make the button work": it performs a real, useful action.
    root.querySelectorAll('.tee-rerun-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cmd = btn.dataset.cmd;
        const original = btn.textContent;
        const onOk = () => {
          btn.textContent = '✓ Commande copiée — colle-la dans ton terminal';
          btn.classList.add('is-copied');
          setTimeout(() => { btn.textContent = original; btn.classList.remove('is-copied'); }, 2200);
        };
        const onFail = () => { btn.textContent = `Copie manuelle : ${cmd}`; };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(cmd).then(onOk, onFail);
        } else {
          onFail();
        }
      });
    });

    const state = { cat: '', q: '', results: new Set(['Passed', 'Failed', 'Skipped', 'Rerun']) };

    function applyFilters() {
      let anyVisible = false;
      root.querySelectorAll('.tee-group').forEach((group) => {
        let groupHasVisible = false;
        group.querySelectorAll('.tee-row').forEach((row) => {
          const cat = row.dataset.category;
          const result = row.dataset.result;
          const text = row.dataset.search;
          const resultBucket = result === 'XPassed' ? 'Passed' : result === 'Error' || result === 'XFailed' ? (result === 'Error' ? 'Failed' : 'Skipped') : result;
          const matchCat = !state.cat || cat === state.cat;
          const matchQ = !state.q || text.includes(state.q);
          const matchResult = state.results.has(resultBucket);
          const visible = matchCat && matchQ && matchResult;
          row.classList.toggle('tee-hidden', !visible);
          if (visible) { groupHasVisible = true; anyVisible = true; }
        });
        group.classList.toggle('tee-hidden', !groupHasVisible);
        if (groupHasVisible && (state.cat || state.q)) group.classList.add('is-open');
      });
      root.querySelector('.tee-empty-state').hidden = anyVisible;
    }

    const pillbar = root.querySelector('.tee-pillbar');
    pillbar.addEventListener('click', (e) => {
      const btn = e.target.closest('.tee-pill');
      if (!btn) return;
      pillbar.querySelectorAll('.tee-pill').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      state.cat = btn.dataset.cat;
      applyFilters();
    });

    root.querySelector('.tee-search').addEventListener('input', (e) => {
      state.q = e.target.value.trim().toLowerCase();
      applyFilters();
    });

    root.querySelectorAll('.tee-resultpill input').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) state.results.add(cb.dataset.result);
        else state.results.delete(cb.dataset.result);
        applyFilters();
      });
    });
  }

  function enhance() {
    const data = parseData();
    if (!data) return;
    const model = buildModel(data);

    const dashboard = renderDashboard(data, model);

    // Hide the original elements individually — NEVER walk up to an unknown ancestor and
    // hide that (a previous version did legacy.parentElement, which in some pytest-html
    // layouts IS <body> itself, hiding everything including the dashboard we're about to
    // insert). Target only the specific known elements.
    ['h1', 'body > p', '#environment-header', '#environment', '.summary', '#results-table'].forEach((sel) => {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    });

    document.body.insertBefore(dashboard, document.body.firstChild);
    wireInteractions(dashboard);
  }

  ready(function () {
    // pytest-html renders the legacy table async (reads localStorage, builds DOM) — our
    // data comes straight from the JSON blob though, so we don't need to wait for that.
    enhance();
  });
})();
