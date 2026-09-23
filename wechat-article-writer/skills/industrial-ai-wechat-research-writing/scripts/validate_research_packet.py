#!/usr/bin/env python3
"""Validate an industrial research packet using only the Python standard library.

Exit codes:
  0  packet is valid
  1  packet parsed but violates the schema
  2  usage, file, or JSON parsing error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

SCHEMA_VERSION = "industrial-research-packet.v1"
CONTENT_TYPES = {"flash", "tool_review", "standard_analysis", "deep_research", "case_review"}
STATUSES = {"complete", "partial", "blocked", "manual_required"}
ACCESS_STATUSES = {"accessible", "partial", "blocked", "manual_required"}
USAGE_STATUSES = {"allowed", "metadata_only", "manual_required", "unknown"}
SOURCE_LEVELS = {
    "standard",
    "government",
    "official",
    "research_institution",
    "academic",
    "industry_association",
    "vendor",
    "exchange",
    "secondary",
    "user_material",
}
ACCESSIBLE = {"accessible", "partial"}
CLAIM_KINDS = {"fact", "definition", "metric", "case_result", "vendor_claim", "inference", "opinion"}
FACT_KINDS = {"fact", "definition", "metric", "case_result", "vendor_claim"}
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MATERIAL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
SHA256 = re.compile(r"^[0-9a-fA-F]{64}$")
# The drive-letter branch is guarded so an ordinary ``https://`` note does
# not look like the ``s:/`` suffix of a Windows path.
LOCAL_PATH_MARKER = re.compile(r"(?i)(?:file://|(?<![A-Za-z0-9])[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])")
# A Unix absolute path may appear after prose (for example ``see /tmp/x``),
# but do not mistake the slashes in ``https://`` or a Chinese slash-delimited
# phrase for one.
UNIX_PATH_MARKER = re.compile(r"(?<![\w:/])/(?!/)[^\s/][^\s]*")
# Only treat a slash-delimited ASCII path as relative-path evidence when it
# has multiple components; this keeps ordinary ``CPU / GPU`` or ``CPU/GPU``
# prose usable while rejecting ``folder/private/quote.xlsx``.
RELATIVE_PATH_MARKER = re.compile(r"(?i)(?<![\w:])(?:[A-Za-z0-9_.-]+/){2,}[^\s]+")
FORWARD_UNC_PATH_MARKER = re.compile(r"(?i)(?<![\w:])//[^/\s]+/")
USER_MATERIAL_CLAIM_FIELDS = {
    "id",
    "text",
    "kind",
    "source_ids",
    "evidence_class",
    "independent_evidence",
    "basis",
}
USER_MATERIAL_FACT_CLAIM_FIELDS = USER_MATERIAL_CLAIM_FIELDS - {"basis"}
USER_MATERIAL_SENSITIVE_MARKER = re.compile(
    r"(?i)vasp\s*(?:source|源码|modif|修改)|pp\s*(?:database|db|数据库)"
    r"|potcar|paw\s*(?:dataset|data|文件)|vasp[_\s-]*pp|pseudopotential"
    r"|credential|credentials|api[_\s-]*key|access[_\s-]*token"
    r"|private[_\s-]*key|client[_\s-]*secret|password|secret|账号|密码|凭证|保密"
    r"|license[_\s-]*(?:key|credential)|许可证(?:密钥|凭证)"
    r"|(?<![\w])token\s*(?:=|:)\s*[A-Za-z0-9._~+/=-]{4,}(?![\w])"
    r"|\bBearer\s+[A-Za-z0-9._~+/=-]{6,}"
)
# User-material entries are metadata-only attestations.  Keep this allowlist
# deliberately scalar so callers cannot smuggle raw documents, credentials,
# or local paths through an innocuous-looking nested object.
USER_MATERIAL_FIELDS = {
    "id",
    "title",
    "organization",
    "source_level",
    "access_status",
    "usage_status",
    "retrieved_at",
    "material_id",
    "sha256",
    "as_of",
    "rights_confirmed",
    "sensitivity_reviewed",
    "usage_notes",
    "material_kind",
    "content_class",
    "notes",
    "coverage",
    "evidence_scope",
    "sensitive",
    "contains_sensitive",
    "contains_vasp_protected_material",
    "contains_restricted_vasp_material",
    "protected_material",
    "contains_restricted_material",
    "contains_credentials",
    "contains_account_data",
    "contains_confidential_material",
    "contains_vasp_source",
    "contains_vasp_pp",
    "contains_potcar",
    "contains_paw_dataset",
}
USER_MATERIAL_BOOLEAN_FIELDS = {
    "rights_confirmed",
    "sensitivity_reviewed",
    "sensitive",
    "contains_sensitive",
    "contains_vasp_protected_material",
    "contains_restricted_vasp_material",
    "protected_material",
    "contains_restricted_material",
    "contains_credentials",
    "contains_account_data",
    "contains_confidential_material",
    "contains_vasp_source",
    "contains_vasp_pp",
    "contains_potcar",
    "contains_paw_dataset",
}
FORBIDDEN_MATERIAL_FIELDS = {
    "content",
    "body",
    "raw_text",
    "path",
    "local_path",
    "file_path",
    "secret",
    "token",
    "password",
}


def _is_nonempty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _is_iso_date(value: Any) -> bool:
    if not isinstance(value, str) or not ISO_DATE.fullmatch(value):
        return False
    try:
        date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _is_optional_iso_date(value: Any) -> bool:
    return value is None or value == "" or _is_iso_date(value)


def _unique_ids(items: Any, label: str, errors: list[str]) -> dict[str, dict[str, Any]]:
    if not isinstance(items, list):
        errors.append(f"{label} must be an array")
        return {}
    result: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            errors.append(f"{label}[{index}] must be an object")
            continue
        item_id = item.get("id")
        if not _is_nonempty_string(item_id):
            errors.append(f"{label}[{index}].id must be a non-empty string")
            continue
        item_id = item_id.strip()
        if item_id in result:
            errors.append(f"duplicate {label} id: {item_id}")
        else:
            result[item_id] = item
    return result


def _validate_url(url: Any) -> bool:
    if not isinstance(url, str):
        return False
    if not url.strip() or any(char.isspace() for char in url):
        return False
    parsed = urlparse(url)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _contains_local_path(value: str) -> bool:
    """Reject local/UNC/file URI hints in user-material metadata strings."""

    stripped = value.strip()
    return bool(
        LOCAL_PATH_MARKER.search(value)
        or UNIX_PATH_MARKER.search(value)
        or RELATIVE_PATH_MARKER.search(value)
        or FORWARD_UNC_PATH_MARKER.search(value)
        or "\\" in value
        or stripped.startswith(("/", "\\\\"))
    )


def validate_packet(packet: Any) -> list[str]:
    errors: list[str] = []
    if not isinstance(packet, dict):
        return ["packet root must be an object"]

    required = {
        "schema_version",
        "packet_id",
        "topic",
        "content_type",
        "cutoff",
        "research_status",
        "retrieval_status",
        "sources",
        "claims",
        "uncertainties",
    }
    for key in sorted(required - packet.keys()):
        errors.append(f"missing required field: {key}")
    if packet.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION!r}")
    if not _is_nonempty_string(packet.get("packet_id")):
        errors.append("packet_id must be a non-empty string")
    if not _is_nonempty_string(packet.get("topic")):
        errors.append("topic must be a non-empty string")
    if packet.get("content_type") not in CONTENT_TYPES:
        errors.append(f"content_type must be one of {sorted(CONTENT_TYPES)}")
    if not _is_iso_date(packet.get("cutoff")):
        errors.append("cutoff must be an ISO date (YYYY-MM-DD)")
    cutoff_date = date.fromisoformat(packet["cutoff"]) if _is_iso_date(packet.get("cutoff")) else None
    for key in ("research_status", "retrieval_status"):
        if packet.get(key) not in STATUSES:
            errors.append(f"{key} must be one of {sorted(STATUSES)}")

    sources = _unique_ids(packet.get("sources"), "sources", errors)
    for source_id, source in sources.items():
        for key in ("title", "organization"):
            if not _is_nonempty_string(source.get(key)):
                errors.append(f"sources[{source_id}].{key} must be a non-empty string")
        if (
            not _validate_url(source.get("url"))
            and (source.get("source_level") != "user_material" or source.get("url") not in (None, ""))
        ):
            errors.append(f"sources[{source_id}].url must be an absolute http(s) URL")
        if source.get("source_level") not in SOURCE_LEVELS:
            errors.append(f"sources[{source_id}].source_level is invalid")
        if source.get("access_status") not in ACCESS_STATUSES:
            errors.append(f"sources[{source_id}].access_status is invalid")
        if source.get("usage_status") not in USAGE_STATUSES:
            errors.append(f"sources[{source_id}].usage_status is invalid")
        usage_notes = source.get("usage_notes")
        if usage_notes not in (None, "") and not _is_nonempty_string(usage_notes):
            errors.append(f"sources[{source_id}].usage_notes must be a string when provided")
        if not _is_iso_date(source.get("retrieved_at")):
            errors.append(f"sources[{source_id}].retrieved_at must be an ISO date")
        for date_field in ("published_at", "effective_at"):
            if not _is_optional_iso_date(source.get(date_field)):
                errors.append(f"sources[{source_id}].{date_field} must be an ISO date when provided")
        version = source.get("version")
        if version not in (None, "") and not _is_nonempty_string(version):
            errors.append(f"sources[{source_id}].version must be a string when provided")
        if source.get("source_level") == "user_material":
            unknown_fields = sorted(set(source) - USER_MATERIAL_FIELDS)
            if unknown_fields:
                errors.append(
                    f"sources[{source_id}] user_material has unsupported fields: {unknown_fields}"
                )
                if "url" in unknown_fields:
                    errors.append(f"sources[{source_id}] user_material must not include url")
            for field, value in source.items():
                if isinstance(value, (dict, list)):
                    errors.append(
                        f"sources[{source_id}].{field} must be a scalar user_material metadata field"
                    )
                elif isinstance(value, str) and _contains_local_path(value):
                    errors.append(
                        f"sources[{source_id}].{field} must not contain a local, UNC, or file URI path"
                    )
            for field in USER_MATERIAL_BOOLEAN_FIELDS:
                if field in source and not isinstance(source[field], bool):
                    errors.append(f"sources[{source_id}].{field} must be boolean")
            material_id = source.get("material_id")
            if not isinstance(material_id, str) or not MATERIAL_ID.fullmatch(material_id):
                errors.append(f"sources[{source_id}].material_id must be a safe non-path identifier")
            if not isinstance(source.get("sha256"), str) or not SHA256.fullmatch(source.get("sha256", "")):
                errors.append(f"sources[{source_id}].sha256 must be a 64-character hex digest")
            if not _is_iso_date(source.get("as_of")):
                errors.append(f"sources[{source_id}].as_of must be an ISO date")
            rights_unclear = source.get("rights_confirmed") is not True
            sensitivity_unclear = source.get("sensitivity_reviewed") is not True
            if source.get("usage_status") == "allowed" and rights_unclear:
                errors.append(f"sources[{source_id}].rights_confirmed must be true for usable user material")
            if source.get("usage_status") == "allowed" and sensitivity_unclear:
                errors.append(f"sources[{source_id}].sensitivity_reviewed must be true for usable user material")
            if rights_unclear and source.get("usage_status") not in {"manual_required", "metadata_only"}:
                errors.append(f"sources[{source_id}] unclear rights require usage_status=manual_required or metadata_only")
            if sensitivity_unclear and source.get("usage_status") not in {"manual_required", "metadata_only"}:
                errors.append(f"sources[{source_id}] unreviewed sensitivity requires usage_status=manual_required or metadata_only")
            for field in FORBIDDEN_MATERIAL_FIELDS:
                if field in source:
                    errors.append(f"sources[{source_id}] must not include raw content or local/secrets field: {field}")
            descriptor = " ".join(
                str(source.get(field, ""))
                for field in ("title", "notes", "material_kind", "content_class")
            ).lower()
            protected = any(
                source.get(flag) is True
                for flag in (
                    "sensitive",
                    "contains_sensitive",
                    "contains_vasp_protected_material",
                    "contains_restricted_vasp_material",
                    "protected_material",
                    "contains_restricted_material",
                    "contains_credentials",
                    "contains_account_data",
                    "contains_confidential_material",
                    "contains_vasp_source",
                    "contains_vasp_pp",
                    "contains_potcar",
                    "contains_paw_dataset",
                )
            ) or bool(
                re.search(
                    r"vasp\s*(source|源码|modif|修改)|pp\s*(database|db|数据库)|potcar|paw\s*(dataset|data|文件)|vasp[_\s-]*pp|pseudopotential|credential|credentials|账号|密码|secret|access[_\s-]*token|api[_\s-]*key|confidential|保密|许可证(?:凭证|密钥)|license\s*(?:key|credential)",
                    descriptor,
                )
            )
            if protected and source.get("usage_status") not in {"manual_required", "metadata_only"}:
                errors.append(f"sources[{source_id}] protected material must be manual_required or metadata_only")

    claims = _unique_ids(packet.get("claims"), "claims", errors)
    for claim_id, claim in claims.items():
        for key in ("text", "kind"):
            if not _is_nonempty_string(claim.get(key)):
                errors.append(f"claims[{claim_id}].{key} must be a non-empty string")
        kind = claim.get("kind")
        if kind not in CLAIM_KINDS:
            errors.append(f"claims[{claim_id}].kind is invalid")
        source_ids = claim.get("source_ids")
        if not isinstance(source_ids, list) or any(not _is_nonempty_string(item) for item in source_ids):
            errors.append(f"claims[{claim_id}].source_ids must be an array of ids")
            source_ids = []
        if kind in FACT_KINDS and not source_ids:
            errors.append(f"claims[{claim_id}] factual claim needs at least one source id")
        if kind in {"inference", "opinion"} and not source_ids:
            if not _is_nonempty_string(claim.get("evidence_class")):
                errors.append(f"claims[{claim_id}] source-free inference/opinion needs evidence_class")
            if not _is_nonempty_string(claim.get("basis")):
                errors.append(f"claims[{claim_id}] source-free inference/opinion needs a brief basis")
        unknown_sources = [source_id for source_id in source_ids if source_id not in sources]
        if unknown_sources:
            errors.append(f"claims[{claim_id}] references unknown source ids: {unknown_sources}")
        referenced = [sources[source_id] for source_id in source_ids if source_id in sources]
        if any(source.get("usage_status") != "allowed" for source in referenced):
            errors.append(f"claims[{claim_id}] cannot use metadata-only/manual/unknown source as content evidence")
        user_material_sources = [
            source for source in referenced if source.get("source_level") == "user_material"
        ]
        if claim.get("evidence_class") == "user_material" and not user_material_sources:
            errors.append(f"claims[{claim_id}] evidence_class=user_material requires a user_material source")
        if "independent_evidence" in claim and not isinstance(claim["independent_evidence"], bool):
            errors.append(f"claims[{claim_id}].independent_evidence must be boolean")
        if user_material_sources:
            if "evidence_quotes" in claim:
                errors.append(
                    f"claims[{claim_id}] user_material claims must not include evidence_quotes"
                )
            if claim.get("evidence_class") != "user_material":
                errors.append(f"claims[{claim_id}] user_material evidence requires evidence_class=user_material")
            if "independent_evidence" in claim and claim.get("independent_evidence") is not False:
                errors.append(f"claims[{claim_id}] user_material evidence cannot be marked independent")
            if any(source.get("source_level") != "user_material" for source in referenced):
                errors.append(
                    f"claims[{claim_id}] user_material provenance must be split from other source levels"
                )
            allowed_claim_fields = (
                USER_MATERIAL_CLAIM_FIELDS
                if kind in {"inference", "opinion"}
                else USER_MATERIAL_FACT_CLAIM_FIELDS
            )
            unknown_claim_fields = sorted(set(claim) - allowed_claim_fields)
            if unknown_claim_fields:
                errors.append(
                    f"claims[{claim_id}] user_material claim has unsupported fields: {unknown_claim_fields}"
                )
            for field, value in claim.items():
                if field != "source_ids" and isinstance(value, (dict, list)):
                    errors.append(
                        f"claims[{claim_id}].{field} must not be a nested user_material claim field"
                    )
            if "basis" in claim and not _is_nonempty_string(claim.get("basis")):
                errors.append(f"claims[{claim_id}].basis must be a non-empty string when provided")
            for text_field in ("text", "basis"):
                text_value = claim.get(text_field)
                if not isinstance(text_value, str):
                    continue
                if len(text_value) > 500:
                    errors.append(
                        f"claims[{claim_id}] user_material {text_field} exceeds 500 characters"
                    )
                if USER_MATERIAL_SENSITIVE_MARKER.search(text_value):
                    errors.append(
                        f"claims[{claim_id}] user_material {text_field} contains restricted material or credential terms"
                    )
                if _contains_local_path(text_value) or "../" in text_value or "..\\" in text_value:
                    errors.append(
                        f"claims[{claim_id}] user_material {text_field} must not contain a local or relative path"
                    )
        raw_evidence_quotes = claim.get("evidence_quotes", [])
        evidence_quotes = raw_evidence_quotes if isinstance(raw_evidence_quotes, list) else []
        if kind in FACT_KINDS:
            usable = [
                source
                for source in referenced
                if source.get("access_status") in ACCESSIBLE and source.get("usage_status") == "allowed"
            ]
            if not usable:
                errors.append(f"claims[{claim_id}] factual claim needs an accessible or partial source")
            if any(
                source.get("access_status") in {"blocked", "manual_required"}
                or source.get("usage_status") != "allowed"
                for source in referenced
            ):
                errors.append(f"claims[{claim_id}] cannot use blocked/manual/metadata-only source as evidence")
            if cutoff_date is not None:
                for source_id, source in ((source_id, sources[source_id]) for source_id in source_ids if source_id in sources):
                    published_at = source.get("published_at")
                    if _is_iso_date(published_at) and date.fromisoformat(published_at) > cutoff_date:
                        errors.append(
                            f"claims[{claim_id}] cannot use source {source_id} published after cutoff"
                        )
                    as_of = source.get("as_of")
                    if (
                        source.get("source_level") == "user_material"
                        and _is_iso_date(as_of)
                        and date.fromisoformat(as_of) > cutoff_date
                    ):
                        errors.append(
                            f"claims[{claim_id}] cannot use user_material source {source_id} after cutoff"
                        )
            quote_source_ids = {
                quote.get("source_id")
                for quote in evidence_quotes
                if isinstance(quote, dict)
            }
            for source_id, source in ((source_id, sources[source_id]) for source_id in source_ids if source_id in sources):
                if source.get("access_status") != "partial" or source.get("usage_status") != "allowed":
                    continue
                if not (_is_nonempty_string(source.get("coverage")) or _is_nonempty_string(source.get("evidence_scope"))):
                    errors.append(
                        f"claims[{claim_id}] partial source {source_id} needs non-empty coverage or evidence_scope"
                    )
                if source.get("source_level") == "user_material":
                    continue
                if source_id not in quote_source_ids:
                    errors.append(f"claims[{claim_id}] partial source {source_id} needs an evidence_quote")
        if kind == "vendor_claim":
            if not _is_nonempty_string(claim.get("vendor")):
                errors.append(f"claims[{claim_id}] vendor_claim needs a non-empty vendor")
            if claim.get("evidence_class") != "vendor_claim":
                errors.append(f"claims[{claim_id}] vendor_claim must use evidence_class=vendor_claim")
            if claim.get("evidence_class") == "independent" or claim.get("independent_evidence") is True:
                errors.append(f"claims[{claim_id}] vendor claim cannot be marked independent evidence")
            if not any(
                source.get("source_level") == "vendor"
                and source.get("access_status") in ACCESSIBLE
                and source.get("usage_status") == "allowed"
                for source in referenced
            ):
                errors.append(f"claims[{claim_id}] vendor_claim needs an accessible source_level=vendor source")
            if any(
                source.get("source_level") != "vendor"
                and source.get("access_status") in ACCESSIBLE
                and source.get("usage_status") == "allowed"
                for source in referenced
            ):
                errors.append(f"claims[{claim_id}] vendor_claim must keep vendor provenance separate from independent sources")
        elif kind in FACT_KINDS and any(
            source.get("source_level") == "vendor"
            and source.get("access_status") in ACCESSIBLE
            and source.get("usage_status") == "allowed"
            for source in referenced
        ):
            errors.append(
                f"claims[{claim_id}] factual claim cannot use vendor source; split vendor_claim from independent claim"
            )

        quotes = raw_evidence_quotes
        if not isinstance(quotes, list):
            errors.append(f"claims[{claim_id}].evidence_quotes must be an array")
            continue
        for quote_index, quote in enumerate(quotes):
            if not isinstance(quote, dict):
                errors.append(f"claims[{claim_id}].evidence_quotes[{quote_index}] must be an object")
                continue
            quote_source = quote.get("source_id")
            quote_text = quote.get("text")
            if quote_source not in sources:
                errors.append(f"claims[{claim_id}] quote references unknown source id: {quote_source}")
            elif quote_source not in source_ids:
                errors.append(f"claims[{claim_id}] quote source id must also appear in source_ids: {quote_source}")
            elif kind in FACT_KINDS and (
                sources[quote_source].get("access_status") in {"blocked", "manual_required"}
                or sources[quote_source].get("usage_status") != "allowed"
            ):
                errors.append(f"claims[{claim_id}] factual quote cannot use blocked/manual/metadata-only source: {quote_source}")
            if not _is_nonempty_string(quote_text):
                errors.append(f"claims[{claim_id}] quote text must be non-empty")
            elif len(quote_text.strip()) > 240:
                errors.append(f"claims[{claim_id}] quote exceeds 240 characters")

    uncertainties = _unique_ids(packet.get("uncertainties"), "uncertainties", errors)
    for uncertainty_id, uncertainty in uncertainties.items():
        if not _is_nonempty_string(uncertainty.get("text")):
            errors.append(f"uncertainties[{uncertainty_id}].text must be a non-empty string")
        claim_ids = uncertainty.get("claim_ids", [])
        if not isinstance(claim_ids, list) or any(claim_id not in claims for claim_id in claim_ids):
            errors.append(f"uncertainties[{uncertainty_id}].claim_ids contains unknown ids")

    sources_are_usable = any(
        source.get("access_status") in ACCESSIBLE and source.get("usage_status") == "allowed"
        for source in sources.values()
    )
    for status_key in ("research_status", "retrieval_status"):
        status = packet.get(status_key)
        if status == "complete":
            if not sources:
                errors.append(f"{status_key}=complete requires a non-empty sources array")
            if not claims:
                errors.append(f"{status_key}=complete requires a non-empty claims array")
            if not sources_are_usable:
                errors.append(f"{status_key}=complete requires at least one accessible/partial source with usage_status=allowed")
        elif status in {"partial", "blocked", "manual_required"} and not uncertainties:
            errors.append(f"{status_key}={status} requires a non-empty uncertainties array")

    return errors


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate an industrial-research-packet.v1 JSON file (stdlib only)."
    )
    parser.add_argument("packet", type=Path, help="path to a packet JSON file")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        return int(exc.code)
    try:
        raw = args.packet.read_text(encoding="utf-8")
        packet = json.loads(raw)
    except OSError as exc:
        print(f"I/O error: {exc}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as exc:
        print(f"JSON parse error at line {exc.lineno}, column {exc.colno}: {exc.msg}", file=sys.stderr)
        return 2
    errors = validate_packet(packet)
    if errors:
        for error in errors:
            print(f"INVALID: {error}", file=sys.stderr)
        return 1
    print(f"VALID: {args.packet}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
