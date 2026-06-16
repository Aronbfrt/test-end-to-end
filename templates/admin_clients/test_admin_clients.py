"""Admin — '/admin/clients' CRUD. Copy this folder+file per entity (admin_products,
admin_orders...), rename the class, adapt the 4 class attrs. Logic lives once in
utils/crud_base.py — never duplicated.
"""
import pytest
from tests.utils.crud_base import CRUDTestBase


@pytest.mark.admin
class TestClientsCRUD(CRUDTestBase):
    RESOURCE        = 'clients'
    CREATE_PATH     = '/admin/clients/create'
    LIST_PATH       = '/admin/clients'
    REQUIRED_FIELDS = ['name', 'email']
