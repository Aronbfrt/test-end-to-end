"""Page Object — admin dashboard, users, generic list/create views."""
from selenium.webdriver.common.by import By


class DashboardPage:
    PATH        = '/admin/dashboard'
    STAT_CARD   = (By.CSS_SELECTOR, '.stat-card, [data-stat], .card')
    SIDEBAR_NAV = (By.CSS_SELECTOR, 'nav a, aside a, .sidebar a')


class UsersPage:
    PATH         = '/admin/users'
    CREATE_PATH  = '/admin/users/create'
    TABLE        = (By.CSS_SELECTOR, 'table, .user-list, [data-users]')
    ROW          = (By.CSS_SELECTOR, 'tbody tr, .user-row')
    SEARCH_INPUT = (By.CSS_SELECTOR, 'input[type=search], input[name=q], input[name=search]')
    EMAIL_INPUT  = (By.NAME, 'email')


class AdminListPage:
    """Generic list view shape, reused by CRUDTestBase for any entity."""
    ERROR_BANNER = (By.CSS_SELECTOR, '.error, [role=alert], .invalid-feedback')
    EXPORT_BTN   = (By.CSS_SELECTOR, 'a[href*=export], a[href*=csv], [data-export]')
