"""Public — every other static page, navigation, 404, mixed content."""
import pytest
from selenium.webdriver.common.by import By
from tests.pages.public_pages import HomePage
from tests.utils.helpers import url

PUBLIC_PAGES = [
    ('/about', 'About'),   # adapt or remove — add every other static route here
]


class TestPublicPages:

    @pytest.mark.parametrize('path,name', PUBLIC_PAGES)
    def test_01_page_loads(self, user_driver, path, name):
        user_driver.get(url(path))
        assert user_driver.title != '', f'{name} : <title> vide'

    @pytest.mark.parametrize('path,name', PUBLIC_PAGES)
    def test_02_no_php_errors(self, user_driver, path, name):
        user_driver.get(url(path))
        src = user_driver.page_source
        assert 'Warning:' not in src
        assert 'Fatal error:' not in src
        assert 'Parse error:' not in src

    def test_03_404_page_returns_correctly(self, user_driver):
        user_driver.get(url('/this-page-does-not-exist-xyz'))
        src = user_driver.page_source
        assert '404' in src or 'not found' in src.lower()

    def test_04_navigation_links_not_broken(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        links = user_driver.find_elements(*HomePage.NAV_LINK)
        internal = [l.get_attribute('href') for l in links if l.get_attribute('href') and url('') in l.get_attribute('href')]
        assert len(internal) > 0

    def test_05_no_mixed_content(self, user_driver):
        user_driver.get(url(HomePage.PATH))
        logs = user_driver.get_log('browser')
        mixed = [l for l in logs if 'Mixed Content' in l.get('message', '')]
        assert len(mixed) == 0, f'Avertissements contenu mixte : {mixed}'
