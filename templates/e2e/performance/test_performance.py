"""Performance — load-time budget, console error budget, heavy asset detection.
Not a Lighthouse replacement — fast smoke-level perf gate for CI."""
import pytest
from tests.pages.public_pages import HomePage
from tests.utils.helpers import url
from tests.utils.checks import check_load_budget, check_no_console_errors, check_no_oversized_images


@pytest.mark.performance
class TestLoadTime:

    def test_01_home_loads_within_budget(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_load_budget(user_driver)

    def test_02_no_console_errors_on_home(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_no_console_errors(user_driver)


@pytest.mark.performance
class TestAssetWeight:

    def test_01_no_oversized_images(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_no_oversized_images(user_driver)

    def test_02_no_render_blocking_explosion(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        css_count = user_driver.execute_script("return document.querySelectorAll('link[rel=stylesheet]').length")
        assert css_count <= 10, f'{css_count} feuilles de style bloquantes — envisager un bundling'
