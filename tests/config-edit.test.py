import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument("--work-directory", required=True)
args = parser.parse_args()
root = Path(args.work_directory).resolve()
root.mkdir(parents=True, exist_ok=False)
script = Path(__file__).resolve().parents[1] / "scripts/config-edit.py"
url = "http://127.0.0.1:49233/backend-api/codex"


class ConfigTransactions(unittest.TestCase):
    def setUp(self):
        self.directory = root / self._testMethodName
        self.directory.mkdir()
        self.config = self.directory / "config.toml"
        self.state = self.directory / "transaction.json"

    def run_action(self, action, success=True):
        command = [sys.executable, "-X", "utf8", str(script), action, "--state", str(self.state)]
        if action == "prepare":
            command += ["--config", str(self.config), "--url", url]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode == 0, success, result.stdout)
        return json.loads(result.stdout)

    def test_root_key_and_nested_same_name_are_distinct(self):
        before = b'model = "example"\n[profiles.example]\nopenai_base_url = "nested-unchanged"\n'
        self.config.write_bytes(before)
        self.run_action("prepare"); self.run_action("apply")
        self.assertIn(b'openai_base_url = "nested-unchanged"', self.config.read_bytes())
        self.run_action("restore"); self.assertEqual(self.config.read_bytes(), before)

    def test_bom_comment_and_crlf_restore_byte_for_byte(self):
        before = b'\xef\xbb\xbf#openai_base_url = "http://127.0.0.1:49001/backend-api/codex"\r\nmodel = "example"\r\n'
        self.config.write_bytes(before)
        self.run_action("prepare"); self.run_action("apply"); self.run_action("restore")
        self.assertEqual(self.config.read_bytes(), before)

    def test_changes_after_prepare_are_not_overwritten(self):
        self.config.write_text('model = "before"\n', encoding="utf-8")
        self.run_action("prepare")
        after = b'model = "user-edit"\n'; self.config.write_bytes(after)
        self.run_action("apply", success=False)
        self.assertEqual(self.config.read_bytes(), after)

    def test_restore_preserves_later_unrelated_settings(self):
        self.config.write_text('model = "before"\n', encoding="utf-8")
        self.run_action("prepare"); self.run_action("apply")
        with self.config.open("a", encoding="utf-8") as out: out.write('model_reasoning_effort = "high"\n')
        self.assertEqual(self.run_action("apply")["status"], "already_applied")
        self.run_action("restore")
        self.assertEqual(self.config.read_text(encoding="utf-8"), 'model = "before"\nmodel_reasoning_effort = "high"\n')

    def test_later_base_url_change_is_not_owned(self):
        self.config.write_text('model = "before"\n', encoding="utf-8")
        self.run_action("prepare"); self.run_action("apply")
        after = b'openai_base_url = "http://127.0.0.1:49991/backend-api/codex"\nmodel = "before"\n'
        self.config.write_bytes(after)
        self.assertEqual(self.run_action("restore")["status"], "not_owned")
        self.assertEqual(self.config.read_bytes(), after)

    def test_custom_remote_url_is_not_silently_taken_over(self):
        before = b'openai_base_url = "https://example.invalid/custom"\n'
        self.config.write_bytes(before)
        self.run_action("prepare", success=False)
        self.assertEqual(self.config.read_bytes(), before)

    def test_key_text_inside_multiline_string_is_not_edited(self):
        before = b'note = """\nopenai_base_url = \'text only\'\n"""\nmodel = "before"\n'
        self.config.write_bytes(before)
        self.run_action("prepare"); self.run_action("apply"); self.run_action("restore")
        self.assertEqual(self.config.read_bytes(), before)

    def test_commit_rechecks_bytes_after_earlier_inspection(self):
        spec = importlib.util.spec_from_file_location("config_edit", script)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        before = b'model = "before"\n'; self.config.write_bytes(before)
        expected = hashlib.sha256(before).hexdigest()
        newer = b'model = "newer"\n'; self.config.write_bytes(newer)
        with self.assertRaises(module.ConfigError):
            module.write_if_unchanged(self.config, expected, b'model = "bridge-write"\n')
        self.assertEqual(self.config.read_bytes(), newer)


unittest.main(argv=[__file__], verbosity=2)
