"""Home — '/' : load, console, perf, a11y, responsive in one place."""
import pytest
from tests.pages.public_pages import HomePage
from tests.utils.helpers import url
from tests.utils.checks import (
    check_no_console_errors, check_load_budget, check_no_oversized_images,
    check_accessibility, check_no_horizontal_overflow,
)

BREAKPOINTS = [(375, 800, 'mobile'), (768, 1024, 'tablet'), (1280, 900, 'desktop'), (1920, 1080, 'wide')]


class TestHome:

    @pytest.mark.smoke
    def test_01_loads(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        assert user_driver.title != ''

    def test_02_no_console_errors(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_no_console_errors(user_driver)

    @pytest.mark.performance
    def test_03_load_budget(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_load_budget(user_driver)

    @pytest.mark.performance
    def test_04_no_oversized_images(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_no_oversized_images(user_driver)

    @pytest.mark.a11y
    def test_05_accessibility(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        check_accessibility(user_driver)

    @pytest.mark.responsive
    @pytest.mark.parametrize('width,height,label', BREAKPOINTS)
    def test_06_no_horizontal_overflow(self, mobile_driver, width, height, label):
        mobile_driver.set_window_size(width, height)
        mobile_driver.get(url(HomePage.PATH))
        check_no_horizontal_overflow(mobile_driver, label)
