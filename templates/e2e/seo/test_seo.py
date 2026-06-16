"""SEO — generic on-page checks swept across key pages. `/e2e-audit` adds one entry per
discovered route automatically; fill SEO_PAGES by hand if running /e2e-init alone."""
import pytest
from tests.pages.public_pages import HomePage
from tests.utils.helpers import url
from tests.utils.checks import check_no_console_errors
from tests.utils.seo_checks import (
    check_title_tag, check_meta_description, check_canonical_tag,
    check_single_h1, check_images_have_alt, check_structured_data_present,
)

SEO_PAGES = [
    (HomePage.PATH, 'Home'),
    # ('/produits/slug-exemple', 'Product detail'),  # /e2e-audit fills these from discovered routes
]


@pytest.mark.seo
class TestOnPageSEO:

    @pytest.mark.parametrize('path,name', SEO_PAGES)
    def test_01_title_tag(self, user_driver, path, name):
        user_driver.get(url(path))
        check_title_tag(user_driver)

    @pytest.mark.parametrize('path,name', SEO_PAGES)
    def test_02_meta_description(self, user_driver, path, name):
        user_driver.get(url(path))
        check_meta_description(user_driver)

    @pytest.mark.parametrize('path,name', SEO_PAGES)
    def test_03_canonical_tag(self, user_driver, path, name):
        user_driver.get(url(path))
        check_canonical_tag(user_driver)

    @pytest.mark.parametrize('path,name', SEO_PAGES)
    def test_04_single_h1(self, user_driver, path, name):
        user_driver.get(url(path))
        check_single_h1(user_driver)

    @pytest.mark.parametrize('path,name', SEO_PAGES)
    def test_05_images_have_alt(self, user_driver, path, name):
        user_driver.get(url(path))
        check_images_have_alt(user_driver)


@pytest.mark.seo
class TestSiteWideSEO:

    def test_01_robots_txt_reachable(self, user_driver):
        from tests.utils.helpers import BASE_URL
        from tests.utils.seo_checks import check_robots_txt_reachable
        check_robots_txt_reachable(user_driver, BASE_URL)

    def test_02_sitemap_reachable(self, user_driver):
        from tests.utils.helpers import BASE_URL
        from tests.utils.seo_checks import check_sitemap_reachable
        check_sitemap_reachable(user_driver, BASE_URL)

    def test_03_homepage_structured_data(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_structured_data_present(user_driver)
