"""Performance — load-time budget, console error budget, heavy asset detection, DOM size,
First Contentful Paint, compression. Not a Lighthouse replacement — fast smoke-level perf
gate for CI."""
import pytest
from tests.pages.public_pages import HomePage
from tests.utils.helpers import url, BASE_URL
from tests.utils.checks import (
    check_load_budget, check_no_console_errors, check_no_oversized_images,
    check_no_render_blocking_js, check_total_page_weight, check_dom_size_budget,
    check_first_contentful_paint, check_gzip_compression,
)


@pytest.mark.performance
class TestLoadTime:

    def test_01_home_loads_within_budget(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_load_budget(user_driver)

    def test_02_no_console_errors_on_home(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_no_console_errors(user_driver)

    def test_03_first_contentful_paint(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_first_contentful_paint(user_driver)


@pytest.mark.performance
class TestAssetWeight:

    def test_01_no_oversized_images(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_no_oversized_images(user_driver)

    def test_02_no_render_blocking_explosion(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        css_count = user_driver.execute_script("return document.querySelectorAll('link[rel=stylesheet]').length")
        assert css_count <= 10, f'{css_count} feuilles de style bloquantes — envisager un bundling'

    def test_03_no_render_blocking_js(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_no_render_blocking_js(user_driver)

    def test_04_total_page_weight(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_total_page_weight(user_driver)

    def test_05_dom_size_budget(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_dom_size_budget(user_driver)


@pytest.mark.performance
class TestCompression:

    def test_01_gzip_or_brotli_enabled(self, api):
        check_gzip_compression(api, BASE_URL + '/')
