"""SEO checks — every assertion message says what's wrong AND why it matters, so the
HTML report explains itself without opening devtools. Tag tests with @pytest.mark.seo.
"""
from selenium.webdriver.common.by import By


def check_title_tag(driver, min_len: int = 10, max_len: int = 65) -> None:
    title = driver.title.strip()
    assert title, '[SEO] missing <title> — every indexed page needs a unique title or it shows as untitled in search results'
    assert min_len <= len(title) <= max_len, \
        f'[SEO] <title> length {len(title)} chars (got "{title}") outside {min_len}-{max_len} — Google truncates titles past ~60 chars in SERPs'


def check_meta_description(driver, min_len: int = 70, max_len: int = 160) -> None:
    els = driver.find_elements(By.CSS_SELECTOR, 'meta[name=description]')
    assert els, '[SEO] missing <meta name="description"> — Google falls back to a random page snippet instead of your CTA-driven copy'
    content = els[0].get_attribute('content') or ''
    assert min_len <= len(content) <= max_len, \
        f'[SEO] meta description length {len(content)} chars outside {min_len}-{max_len} — too short wastes SERP space, too long gets truncated'


def check_canonical_tag(driver) -> None:
    els = driver.find_elements(By.CSS_SELECTOR, 'link[rel=canonical]')
    assert els, '[SEO] missing <link rel="canonical"> — risk of duplicate-content penalty if the same page is reachable via multiple URLs'


def check_single_h1(driver) -> None:
    h1s = driver.find_elements(By.TAG_NAME, 'h1')
    assert len(h1s) >= 1, '[SEO] no <h1> found — search engines use it as the primary topic signal for the page'
    assert len(h1s) == 1, f'[SEO] {len(h1s)} <h1> tags found — multiple H1s dilute the topic signal, keep exactly one'


def check_images_have_alt(driver, max_missing_ratio: float = 0.1) -> None:
    imgs = driver.find_elements(By.TAG_NAME, 'img')
    if not imgs:
        return
    missing = [i for i in imgs if not (i.get_attribute('alt') or '').strip()]
    ratio = len(missing) / len(imgs)
    assert ratio <= max_missing_ratio, \
        f'[SEO] {len(missing)}/{len(imgs)} images missing alt text — hurts image search ranking and screen-reader accessibility'


def check_structured_data_present(driver) -> None:
    els = driver.find_elements(By.CSS_SELECTOR, 'script[type="application/ld+json"]')
    assert els, '[SEO] no JSON-LD structured data — missing rich-result eligibility (price/rating stars in search results)'


def check_status_200(driver) -> None:
    """Heuristic since Selenium has no direct response-code API — looks for common error markers."""
    src = driver.page_source.lower()
    error_markers = ['404 not found', '500 internal server error', 'whitelabel error page']
    hit = [m for m in error_markers if m in src]
    assert not hit, f'[SEO] page returned an error state ({hit[0]}) — error pages must not be indexable, check the actual HTTP status'


def check_robots_txt_reachable(driver, base_url: str) -> None:
    driver.get(base_url + '/robots.txt')
    src = driver.page_source.lower()
    assert '404' not in driver.title.lower(), '[SEO] /robots.txt unreachable — crawlers can\'t read crawl directives, sitemap location'


def check_sitemap_reachable(driver, base_url: str) -> None:
    driver.get(base_url + '/sitemap.xml')
    assert '<urlset' in driver.page_source or '<sitemapindex' in driver.page_source, \
        '[SEO] /sitemap.xml missing or malformed — search engines discover pages slower without it'
