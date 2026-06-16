"""pytest-html report enrichment — extra columns and custom JS dashboard injection.

Column layout (must stay in sync with report_theme.js's resultsTableRow parsing):
  col 0  result     pytest-html built-in
  col 1  testId     pytest-html built-in
  col 2  Category   ← injected here (security / seo / a11y / ...)
  col 3  Visuel     ← injected here (visual regression %)
  col 4  Stabilité  ← injected here (flaky flag)
  col 5  Sélecteur  ← injected here (self-heal count)
  col 6  Duration   pytest-html built-in (shifted right by our 4 inserts)
  col 7  Links      pytest-html built-in

If you add or remove a column here, update report_theme.js's buildModel() accordingly
(the cells[] index reads for category/visual/stability/selector).
"""
import os

CATEGORY_MARKERS = ['security', 'seo', 'a11y', 'responsive', 'performance',
                    'admin', 'stripe', 'smoke']


def inject_js(postfix) -> None:
    """Injects report_theme.js into pytest-html's postfix section.

    Why postfix and not a separate file: pytest-html rebuilds #results-table from scratch
    on every filter/sort click — any DOM patch on it gets wiped immediately. Reading the
    same JSON blob and rendering our own view (report_theme.js) sidesteps that entirely.
    """
    js_path = os.path.join(os.path.dirname(__file__), 'report_theme.js')
    try:
        with open(js_path, encoding='utf-8') as f:
            postfix.append(f'<script>{f.read()}</script>')
    except OSError:
        pass


def table_header(cells) -> None:
    """Inserts the 4 extra <th> headers at columns 2–5."""
    cells.insert(2, '<th>Category</th>')
    cells.insert(3, '<th>Visuel</th>')
    cells.insert(4, '<th>Stabilité</th>')
    cells.insert(5, '<th>Sélecteur</th>')


def table_row(report, cells, flaky_info_fn) -> None:
    """Inserts the 4 extra <td> values at columns 2–5 for a given test report.

    flaky_info_fn — pass flaky.info (the function, not the result) so this module
    doesn't need to import features.flaky directly (avoids a circular-ish import path
    since conftest imports both this module and flaky).
    """
    # Category
    cats = [m for m in CATEGORY_MARKERS if m in report.keywords]
    label = ', '.join(cats) or '-'
    css = ' class="cat-security"' if 'security' in cats else ''
    cells.insert(2, f'<td{css}>{label}</td>')

    # Visual regression
    diff_pct = getattr(report, 'visual_diff_pct', None)
    if diff_pct is None:
        visual_label = '—'
    elif diff_pct == 0.0:
        visual_label = 'identique'
    else:
        visual_label = f'Δ{diff_pct:.1f}%'
    cells.insert(3, f'<td>{visual_label}</td>')

    # Stability / flaky
    flaky = flaky_info_fn(report.nodeid)
    if flaky and flaky[0] > 1:
        stability = f'instable ({flaky[0]}/{flaky[1]})'
    elif flaky:
        stability = 'stable'
    else:
        stability = '—'
    cells.insert(4, f'<td>{stability}</td>')

    # Self-heal
    healed = getattr(report, 'healed_count', 0)
    cells.insert(5, f'<td>{"auto-réparé ×" + str(healed) if healed else "—"}</td>')
