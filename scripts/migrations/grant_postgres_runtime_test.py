import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location(
    "grant_postgres_runtime",Path(__file__).with_name("grant_postgres_runtime.py"))
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class GrantTest(unittest.TestCase):
    def test_role_identifier_validation(self):
        self.assertEqual(m.validate_role("323709301334-compute@developer"),
                         "323709301334-compute@developer")
        for value in ("", "../x", "x; DROP TABLE awfl_documents", '"x"'):
            with self.assertRaises(ValueError):
                m.validate_role(value)
    def test_only_awfl_tables(self):
        self.assertEqual(len(m.TABLES),3)
        self.assertIn("awfl_documents",m.TABLES)
    def test_reject_other_database(self):
        with self.assertRaises(ValueError):
            m.grant_permissions(None,"323709301334-compute@developer","awfl_bench")

if __name__=="__main__":
    unittest.main()
