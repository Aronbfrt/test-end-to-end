"""Responsive — sitewide breakpoint/mobile-nav checks not tied to one specific page."""
import pytest
from tests.pages.public_pages import HomePage, MobileNavPage
from tests.utils.helpers import url


@pytest.mark.responsive
class TestMobileNav:

    def test_01_toggle_present(self, mobile_driver):
        mobile_driver.get(url(HomePage.PATH))
        toggle = mobile_driver.find_elements(*MobileNavPage.TOGGLE)
        assert len(toggle) > 0, 'Aucun bouton menu mobile trouvé — burger manquant ?'

    def test_02_opens(self, mobile_driver):
        mobile_driver.get(url(HomePage.PATH))
        toggles = mobile_driver.find_elements(*MobileNavPage.TOGGLE)
        if not toggles:
            pytest.skip('aucun bouton menu mobile à tester')
        toggles[0].click()
        links = mobile_driver.find_elements(*MobileNavPage.PANEL_LINK)
        assert len(links) > 0, 'Menu mobile ouvert mais aucun lien visible'

    def test_03_tap_targets_min_size(self, mobile_driver):
        """WCAG 2.5.5 — interactive elements should be >= 44x44px on mobile."""
        from selenium.webdriver.common.by import By
        mobile_driver.get(url(HomePage.PATH))
        buttons = mobile_driver.find_elements(By.CSS_SELECTOR, 'button, a.btn, [role=button]')
        too_small = [b for b in buttons if b.is_displayed() and (b.size['width'] < 44 or b.size['height'] < 44)]
        assert len(too_small) <= len(buttons) * 0.2, \
            f'{len(too_small)}/{len(buttons)} cibles tactiles sous 44x44px'
