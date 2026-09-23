#!/usr/bin/env python3
"""Small stdlib regression suite for the research packet validator."""

from __future__ import annotations

import contextlib
import io
import json
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1]
FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
sys.path.insert(0, str(SCRIPT_DIR))

import validate_research_packet as validator


class ResearchPacketValidatorTests(unittest.TestCase):
    def _load(self, path: Path) -> dict:
        return json.loads(path.read_text(encoding="utf-8"))

    def test_examples_are_valid(self) -> None:
        paths = [
            FIXTURE_DIR / "valid-industrial-packet.json",
            FIXTURE_DIR / "valid-user-material.json",
            SCRIPT_DIR.parent / "references" / "example-research-packet.json",
        ]
        for path in paths:
            with self.subTest(path=path.name):
                self.assertEqual(validator.validate_packet(self._load(path)), [])

    def test_all_invalid_fixtures_fail_closed(self) -> None:
        paths = sorted(FIXTURE_DIR.glob("invalid-*.json"))
        self.assertGreaterEqual(len(paths), 5)
        for path in paths:
            with self.subTest(path=path.name):
                self.assertTrue(validator.validate_packet(self._load(path)), path.name)

    def test_status_and_usage_boundaries(self) -> None:
        blocked = self._load(FIXTURE_DIR / "invalid-complete-only-blocked.json")
        metadata_only = self._load(FIXTURE_DIR / "invalid-metadata-only-evidence.json")
        restricted = self._load(FIXTURE_DIR / "invalid-user-material-restricted-vasp.json")
        self.assertTrue(any("complete" in error and "accessible" in error for error in validator.validate_packet(blocked)))
        self.assertTrue(any("metadata" in error for error in validator.validate_packet(metadata_only)))
        self.assertTrue(any("protected material" in error for error in validator.validate_packet(restricted)))

    def test_user_material_allowlist_and_cutoff(self) -> None:
        valid = self._load(FIXTURE_DIR / "valid-user-material.json")
        self.assertEqual(validator.validate_packet(valid), [])
        # The local-paper source deliberately sits exactly on cutoff: equality
        # is valid, while a future as_of must fail closed.
        self.assertEqual(valid["sources"][2]["as_of"], valid["cutoff"])
        future = self._load(FIXTURE_DIR / "invalid-user-material-future-as-of.json")
        self.assertTrue(any("user_material source M1 after cutoff" in error for error in validator.validate_packet(future)))
        allowlist = self._load(FIXTURE_DIR / "invalid-user-material-allowlist.json")
        allowlist_errors = validator.validate_packet(allowlist)
        self.assertTrue(any("unsupported fields" in error for error in allowlist_errors))
        self.assertTrue(any("scalar user_material" in error for error in allowlist_errors))
        self.assertTrue(any("local, UNC, or file URI" in error for error in allowlist_errors))
        mixed = self._load(FIXTURE_DIR / "invalid-user-material-mixed-provenance.json")
        self.assertTrue(any("provenance must be split" in error for error in validator.validate_packet(mixed)))

    def test_user_material_claim_boundaries_and_path_false_positives(self) -> None:
        cases = {
            "invalid-user-material-claim-sensitive.json": "restricted material or credential",
            "invalid-user-material-claim-path.json": "local or relative path",
            "invalid-user-material-claim-unknown-nested.json": "unsupported fields",
            "invalid-user-material-claim-quotes.json": "must not include evidence_quotes",
            "invalid-user-material-claim-independent-string.json": "independent_evidence must be boolean",
            "invalid-user-material-inference-unknown-nested.json": "unsupported fields",
            "invalid-user-material-inference-sensitive-basis.json": "basis contains restricted material or credential",
            "invalid-user-material-credential-patterns.json": "restricted material or credential",
        }
        for filename, expected in cases.items():
            with self.subTest(filename=filename):
                errors = validator.validate_packet(self._load(FIXTURE_DIR / filename))
                self.assertTrue(any(expected in error for error in errors), errors)

        for text in ("CPU / GPU benchmark", "CPU/GPU", "报价 / 交付记录", "计算/实验"):
            with self.subTest(text=text):
                self.assertFalse(validator._contains_local_path(text))
        for text in ("../secret.txt", r"..\secret.txt", r"folder\private\quote.xlsx", "folder/private/quote.xlsx", r"%USERPROFILE%\quote.xlsx", "see //server/share/quote.xlsx"):
            with self.subTest(text=text):
                self.assertTrue(validator._contains_local_path(text))

        partial = self._load(FIXTURE_DIR / "valid-user-material.json")
        partial["sources"][0]["access_status"] = "partial"
        partial["sources"][0]["coverage"] = "报价字段元数据，待人工核对"
        self.assertEqual(validator.validate_packet(partial), [])

        with_url = self._load(FIXTURE_DIR / "valid-user-material.json")
        with_url["sources"][0]["url"] = "https://signed.example.invalid/quote?token=ABC123"
        self.assertTrue(any("must not include url" in error for error in validator.validate_packet(with_url)))

        for text in ("VASP license key=ABC123", "许可证密钥=ABC123", "token=ABC123", "Bearer ABC123"):
            with self.subTest(credential_text=text):
                self.assertTrue(validator.USER_MATERIAL_SENSITIVE_MARKER.search(text))
        for text in ("token budget", "Bearer token", "CPU/GPU benchmark"):
            with self.subTest(non_secret_text=text):
                self.assertIsNone(validator.USER_MATERIAL_SENSITIVE_MARKER.search(text))

    def test_vendor_and_partial_provenance_cannot_be_mixed(self) -> None:
        mixed_vendor = self._load(FIXTURE_DIR / "invalid-vendor-mixed-provenance.json")
        mixed_partial = self._load(FIXTURE_DIR / "invalid-partial-mixed-access.json")
        self.assertTrue(any("split vendor_claim" in error for error in validator.validate_packet(mixed_vendor)))
        partial_errors = validator.validate_packet(mixed_partial)
        self.assertTrue(any("partial source S2" in error and "coverage" in error for error in partial_errors))
        self.assertTrue(any("partial source S2" in error and "evidence_quote" in error for error in partial_errors))

    def test_cli_exit_codes(self) -> None:
        valid = FIXTURE_DIR / "valid-industrial-packet.json"
        invalid = FIXTURE_DIR / "invalid-empty-complete.json"
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(validator.main([str(valid)]), 0)
            self.assertEqual(validator.main([str(invalid)]), 1)
            self.assertEqual(validator.main([str(FIXTURE_DIR / "does-not-exist.json")]), 2)


if __name__ == "__main__":
    unittest.main()
