"""Reader-facing Word export for structured article artifacts.

The writer/research contracts deliberately retain provenance and review
metadata.  This module is the delivery boundary: it consumes those
structured objects, selects only reader-facing fields, and writes a Word
document.  It is intentionally usable as a small stdin/stdout CLI so the
Node HTTP server does not need a second document-generation dependency.

Input: one JSON object on stdin.  Expected keys are ``brief``, ``draft``,
``evidencePacket``, ``wechatPackage`` and ``review``/``reviewReport``.  The
resulting DOCX bytes are written to stdout; diagnostics are written to
stderr and never enter the document.
"""

from __future__ import annotations

import io
import json
import re
import sys
from dataclasses import dataclass, field
from typing import Any, Iterable

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.enum.section import WD_SECTION
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.shared import Cm, Pt, RGBColor


FONT_NAME = "Microsoft YaHei"
BODY_SIZE_PT = 12
BODY_LINE_SPACING = 1.5
BODY_FIRST_LINE_PT = 24  # two 12-point Chinese characters
# Word stores character-based paragraph indents in hundredths of a character.
# Keep the historical 24pt twip value as a compatibility fallback while also
# writing this explicit character value to every reader body paragraph.
BODY_FIRST_LINE_CHARS = 200
CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# These values are control/provenance fields, not article vocabulary.  We do
# not render arbitrary input dictionaries, and we fail closed if one of these
# fields nevertheless reaches a reader text field.
FORBIDDEN_READER_FIELDS = (
    "human_curated",
    "realtime_research",
    "sourceOrigin",
    "claim:",
    "source:",
    "candidate",
    "claimId",
    "sourceId",
    "review_required",
    "Bridge",
    "HTTP 504",
    "research_timeout",
    "EvidencePacket",
    "ArgumentMap",
    "WriterRequest",
    "WechatPackage",
    "clientRunId",
    "allReady",
)

# These are deliberately narrower than ``FORBIDDEN_READER_FIELDS``.  A
# generic substring check would reject ordinary prose (for example a sentence
# mentioning a bridge or a candidate material).  We fail closed only for
# unambiguous control-field spellings, known QA contamination markers, and
# diagnostic phrases that identify the Bridge implementation.
_CONTROL_FIELD_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(?<![A-Za-z0-9_])human_curated(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])realtime_research(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])sourceOrigin(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])claim:(?=\S)",
        r"(?<![A-Za-z0-9_])source:(?=\S)",
        r"(?<![A-Za-z0-9_])claimId(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])sourceId(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])review_required(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])HTTP\s+504(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])research_timeout(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])EvidencePacket(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])ArgumentMap(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])WriterRequest(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])WechatPackage(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])clientRunId(?![A-Za-z0-9_])",
        r"(?<![A-Za-z0-9_])allReady(?![A-Za-z0-9_])",
        # ``candidate`` is only a control marker when it is presented as a
        # draft/result label.  A sentence such as "candidate materials" is
        # legitimate article prose and remains exportable.
        r"(?:\[\s*candidate\s*\]|`candidate`|candidate\s*(?:稿|文章|草稿|输出|结果|draft|article|output|result))",
        # Likewise, preserve a natural company/product name such as "Bridge
        # architecture" while rejecting Bridge diagnostics and the known QA
        # title "Bridge 标记".
        r"(?:\[\s*bridge\s*\]|`bridge`|bridge\s*(?:标记|研究|请求|超时|错误|日志|状态|research|request|timeout|error|log|status|provider|profile))",
    )
)

KNOWN_QA_MARKERS = (
    "浏览器人工编辑验收",
    "浏览器批注修订",
    "人工编辑验收",
    "浏览器验收",
    "测试文章",
    "测试批注",
)

INTERNAL_TOKEN_PATTERN = re.compile(
    r"(?:\[(?:claim|source|evidence|internal):[^\]\r\n]+\]|"
    r"\{\{(?:claim|source|evidence|internal):[^}\r\n]+\}\}|"
    r"<!--\s*internal:[\s\S]*?-->)",
    re.IGNORECASE,
)
URL_PATTERN = re.compile(r"https?://[^\s<>()\u3002，；）】]+", re.IGNORECASE)
MARKDOWN_INLINE_PATTERN = re.compile(r"(\*\*[^*]+\*\*|(?<!\*)\*[^*]+\*(?!\*)|`[^`]+`)")
SUPERSCRIPT_PATTERN = re.compile(r"(?P<base>[A-Za-z\u4e00-\u9fff0-9]+)\^(?P<exponent>[+-]?\d+)")
SUBSCRIPT_PATTERN = re.compile(r"(?P<base>[A-Za-z\u4e00-\u9fff0-9]+)_(?P<subscript>\d+)")


class WordExportError(RuntimeError):
    """A reader-boundary error that should prevent a download."""

    code = "word_export_failed"


class ReaderSafetyError(WordExportError):
    code = "word_export_reader_fields"


def _text(value: Any) -> str:
    """Return a string without silently serialising nested/internal objects."""

    if value is None:
        return ""
    if isinstance(value, (dict, list, tuple, set)):
        raise ReaderSafetyError("Reader text fields must be scalar strings")
    return str(value).strip()


def clean_inline(value: Any) -> str:
    """Remove only explicit inline control tokens and normalise whitespace.

    We intentionally do not drop whole lines based on keyword matches.  Any
    remaining forbidden control field causes export to fail closed in
    :func:`assert_reader_safe` so ordinary prose is never accidentally lost.
    """

    text = INTERNAL_TOKEN_PATTERN.sub("", _text(value))
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\s+([，。；：、！？,.!?])", r"\1", text)
    text = re.sub(r"([（(])\s+", r"\1", text)
    text = re.sub(r"\s+([）)])", r"\1", text)
    return text.strip()


def assert_reader_safe(text: str, context: str = "reader text") -> None:
    # Keep this check structural and fail closed.  The original input object
    # is never mutated or line-filtered; callers receive the original text in
    # their workspace when an export is rejected.
    leaked = [pattern.pattern for pattern in _CONTROL_FIELD_PATTERNS if pattern.search(text)]
    # A bare ``candidate`` is a common internal draft label.  Keep the
    # context-aware patterns above permissive for legitimate phrases such as
    # "candidate material", but reject the label when it stands alone.
    if re.fullmatch(r"candidate", text.strip(), re.IGNORECASE):
        leaked.append("candidate")
    leaked.extend(marker for marker in KNOWN_QA_MARKERS if marker.casefold() in text.casefold())
    if leaked:
        raise ReaderSafetyError(f"{context} contains internal reader fields: {', '.join(leaked)}")


def _first_nonempty(*values: Any) -> str:
    for value in values:
        text = clean_inline(value)
        if text:
            return text
    return ""


def _year(source: dict[str, Any]) -> str:
    explicit = source.get("year")
    if explicit:
        return clean_inline(explicit)
    for key in ("publishedAt", "publicationDate", "date"):
        value = clean_inline(source.get(key))
        match = re.search(r"\b(19|20)\d{2}\b", value)
        if match:
            return match.group(0)
    return ""


def _authors(source: dict[str, Any]) -> str:
    value = source.get("authors", source.get("author", source.get("creator", "")))
    if isinstance(value, list):
        return ", ".join(clean_inline(item) for item in value if clean_inline(item))
    return clean_inline(value)


def _publisher(source: dict[str, Any]) -> str:
    return _first_nonempty(
        source.get("journal"),
        source.get("publication"),
        source.get("publisher"),
        source.get("institution"),
        source.get("venue"),
    )


def _doi_or_url(source: dict[str, Any]) -> str:
    doi = _first_nonempty(source.get("doi"), source.get("DOI"))
    if doi:
        if doi.lower().startswith("http"):
            return doi
        return f"https://doi.org/{doi.removeprefix('doi:').strip()}"
    return clean_inline(source.get("url"))


@dataclass
class ReaderReference:
    index: int
    source_id: str
    authors: str
    title: str
    publisher: str
    year: str
    link: str

    def label(self) -> str:
        parts: list[str] = []
        if self.authors:
            parts.append(self.authors)
        if self.title:
            parts.append(f'“{self.title}”')
        if self.publisher:
            parts.append(self.publisher)
        if self.year:
            parts.append(self.year)
        prefix = f"[{self.index}] " + ", ".join(parts)
        if self.link:
            prefix += f". {self.link}"
        return prefix.rstrip(" .") + ("." if self.link or parts else "")


@dataclass
class ReaderParagraph:
    text: str
    claim_ids: list[str] = field(default_factory=list)
    kind: str = "paragraph"


@dataclass
class ReaderSection:
    heading: str
    paragraphs: list[ReaderParagraph]


@dataclass
class ReaderArticle:
    title: str
    digest: str
    lead: str
    sections: list[ReaderSection]
    closing: str
    references: list[ReaderReference]


def _source_list(payload: dict[str, Any]) -> list[dict[str, Any]]:
    packet = payload.get("evidencePacket") or {}
    sources = packet.get("sources")
    if isinstance(sources, list) and sources:
        return [source for source in sources if isinstance(source, dict)]

    # A WechatPackage sourceLedger is already reader-safe in shape, but it is
    # still treated as an input ledger rather than rendered wholesale.  This
    # fallback lets the export endpoint work with a package-only request.
    package = payload.get("wechatPackage") or {}
    ledger = package.get("sourceLedger")
    flattened: list[dict[str, Any]] = []
    seen: set[str] = set()
    if isinstance(ledger, list):
        for claim in ledger:
            if not isinstance(claim, dict):
                continue
            for source in claim.get("sources", []):
                if not isinstance(source, dict):
                    continue
                source_id = clean_inline(source.get("sourceId"))
                if source_id and source_id in seen:
                    continue
                if source_id:
                    seen.add(source_id)
                flattened.append(source)
    return flattened


def _references(payload: dict[str, Any]) -> list[ReaderReference]:
    references: list[ReaderReference] = []
    for index, source in enumerate(_source_list(payload), start=1):
        reference = ReaderReference(
            index=index,
            source_id=clean_inline(source.get("sourceId")),
            authors=_authors(source),
            title=clean_inline(source.get("title")),
            publisher=_publisher(source),
            year=_year(source),
            link=_doi_or_url(source),
        )
        if not reference.title and not reference.link:
            # Never invent an empty bibliography entry.
            continue
        assert_reader_safe(reference.label(), f"reference {index}")
        references.append(reference)
    # Keep numbers contiguous after dropping malformed/empty source entries.
    for index, reference in enumerate(references, start=1):
        reference.index = index
    return references


def _claim_reference_map(payload: dict[str, Any], references: list[ReaderReference]) -> dict[str, list[int]]:
    source_ids: dict[str, int] = {}
    for index, source in enumerate(_source_list(payload), start=1):
        source_id = clean_inline(source.get("sourceId"))
        if source_id:
            source_ids[source_id] = index
    # If malformed sources were dropped, map by the source ID retained only in
    # this internal model (it is never rendered in the document).
    visible_by_source = {reference.source_id: reference.index for reference in references if reference.source_id}
    visible_by_title = {reference.title: reference.index for reference in references if reference.title}
    mapping: dict[str, list[int]] = {}
    packet = payload.get("evidencePacket") or {}
    for claim in packet.get("claims", []) if isinstance(packet, dict) else []:
        if not isinstance(claim, dict):
            continue
        claim_id = clean_inline(claim.get("claimId"))
        if not claim_id:
            continue
        numbers: list[int] = []
        for source_id in claim.get("evidenceIds", []) if isinstance(claim.get("evidenceIds", []), list) else []:
            source_number = source_ids.get(clean_inline(source_id))
            if source_number is None:
                continue
            # Source indexes are normally contiguous.  Use the visible title
            # if an empty source was skipped by _references.
            source = (_source_list(payload) or [])[source_number - 1]
            source_id = clean_inline(source.get("sourceId")) if isinstance(source, dict) else ""
            title = clean_inline(source.get("title")) if isinstance(source, dict) else ""
            visible_number = visible_by_source.get(source_id) or visible_by_title.get(title)
            if visible_number is not None and visible_number not in numbers:
                numbers.append(visible_number)
        mapping[claim_id] = numbers
    return mapping


def _citation_suffix(claim_ids: Iterable[str], claim_map: dict[str, list[int]]) -> str:
    numbers: list[int] = []
    for claim_id in claim_ids:
        for number in claim_map.get(clean_inline(claim_id), []):
            if number not in numbers:
                numbers.append(number)
    return "" if not numbers else " " + "".join(f"[{number}]" for number in numbers)


def _source_reference_map(payload: dict[str, Any], references: list[ReaderReference]) -> dict[str, int]:
    """Map exact internal source IDs to reader reference numbers."""

    visible_by_source = {reference.source_id: reference.index for reference in references if reference.source_id}
    # The map is intentionally keyed only by the exact source ID.  Positional
    # guessing would silently turn ``[S1]`` into the wrong source whenever the
    # evidence packet is reordered.
    return visible_by_source


def _map_internal_source_tokens(text: str, source_reference_map: dict[str, int]) -> str:
    """Convert exact ``[S1]`` source tokens to reader reference numbers."""

    def replace_source_token(match: re.Match[str]) -> str:
        source_id = match.group(1)
        number = source_reference_map.get(source_id)
        if number is None:
            raise ReaderSafetyError(f"reader text contains unknown source citation [{source_id}]")
        return f"[{number}]"

    # Restrict the token shape to ``S`` followed by digits so ordinary
    # bracketed words such as ``[Source]`` remain untouched.
    return re.sub(r"\[(S\d+)\]", replace_source_token, text)


def _canonicalise_citations(
    text: str,
    claim_ids: Iterable[str],
    claim_map: dict[str, list[int]],
    source_reference_map: dict[str, int],
) -> str:
    """Validate/complete citations from structured claim bindings.

    Numeric labels typed into a draft are never rewritten or deleted.  If a
    paragraph has mapped claims and its explicit ``[n]`` labels disagree with
    the evidence-derived numbers, export fails closed so an editor can fix the
    citation without losing ordinary facts such as ``[99]``.  Internal
    ``[S…]`` labels are converted only when the token matches an exact source
    ID in the evidence packet.
    """

    # ``[S1]``/``[S2]`` is the compact internal source notation used by the
    # research records; resolve it through exact source IDs before validating
    # any numeric labels.
    text = _map_internal_source_tokens(text, source_reference_map)

    mapped: list[int] = []
    for claim_id in claim_ids:
        for number in claim_map.get(clean_inline(claim_id), []):
            if number not in mapped:
                mapped.append(number)
    if not mapped:
        return text

    explicit = [int(match.group(1)) for match in re.finditer(r"\[(?:S)?(\d+)\]", text)]
    if explicit and set(explicit) == set(mapped):
        return text
    if explicit:
        raise ReaderSafetyError(
            "article paragraph citation does not match its evidence bindings "
            f"(typed={explicit}, expected={mapped})"
        )
    return text + _citation_suffix(claim_ids, claim_map)


def _draft_sections(
    draft: dict[str, Any],
    claim_map: dict[str, list[int]],
    source_reference_map: dict[str, int],
) -> list[ReaderSection]:
    sections: list[ReaderSection] = []
    for section in draft.get("sections", []) if isinstance(draft.get("sections", []), list) else []:
        if not isinstance(section, dict):
            continue
        heading = re.sub(r"^#{1,6}\s+", "", clean_inline(section.get("heading")))
        # Structured providers may use the same compact ``[S1]`` notation
        # in a section heading as they do in body paragraphs.  Resolve it by
        # exact source ID before the reader-safety check; never expose the
        # internal token or guess by position.
        heading = _map_internal_source_tokens(heading, source_reference_map)
        if not heading:
            continue
        paragraphs: list[ReaderParagraph] = []
        for paragraph in section.get("paragraphs", []) if isinstance(section.get("paragraphs", []), list) else []:
            if not isinstance(paragraph, dict):
                continue
            text = re.sub(r"^#{1,6}\s+", "", clean_inline(paragraph.get("text")))
            if text.startswith("> "):
                text = text[2:].strip()
            if not text:
                continue
            claim_ids = [clean_inline(value) for value in paragraph.get("claimIds", []) if clean_inline(value)] if isinstance(paragraph.get("claimIds", []), list) else []
            # Claim IDs are internal and never rendered.  Their source numbers
            # are emitted as reader citations so the body remains traceable.
            text = _canonicalise_citations(text, claim_ids, claim_map, source_reference_map)
            assert_reader_safe(text, "article paragraph")
            kind = clean_inline(paragraph.get("kind") or paragraph.get("listType"))
            if kind in {"ul", "bullet", "unordered"}:
                kind = "bullet"
            elif kind in {"ol", "number", "ordered"}:
                kind = "number"
            else:
                # Some providers encode a list item only in its text. Convert
                # those explicit Markdown markers to real Word list
                # paragraphs; normal prose remains untouched.
                bullet = re.match(r"^[-*]\s+(.+)$", text)
                numbered = re.match(r"^\d+[.)]\s+(.+)$", text)
                if bullet:
                    text = bullet.group(1).strip()
                    kind = "bullet"
                elif numbered:
                    text = numbered.group(1).strip()
                    kind = "number"
                else:
                    kind = "paragraph"
            paragraphs.append(ReaderParagraph(text=text, claim_ids=claim_ids, kind=kind))
        if paragraphs:
            sections.append(ReaderSection(heading=heading, paragraphs=paragraphs))
    return sections


def _parse_package_markdown(
    markdown: str,
    claim_map: dict[str, list[int]],
    source_reference_map: dict[str, int],
) -> tuple[str, str, str, list[ReaderSection], str]:
    """Minimal reader fallback for package-only export requests.

    The preferred path is the structured Draft above.  This parser recognises
    only headings, blockquotes, paragraphs and lists; it does not copy package
    metadata or an internal ledger into the document.
    """

    lines = clean_inline(markdown).replace("\r\n", "\n").split("\n")
    title = ""
    lead = ""
    digest = ""
    closing = ""
    sections: list[ReaderSection] = []
    current: ReaderSection | None = None
    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("# ") and not title:
            title = _map_internal_source_tokens(clean_inline(line[2:]), source_reference_map)
            continue
        if line.startswith("> ") and not lead:
            lead = _map_internal_source_tokens(clean_inline(line[2:]), source_reference_map)
            continue
        heading = re.match(r"^##\s+(.+)$", line)
        if heading:
            heading_text = _map_internal_source_tokens(clean_inline(heading.group(1)), source_reference_map)
            # Package Markdown may include a pre-rendered bibliography.  The
            # structured evidence packet is the only source of references in
            # this exporter, so stop before copying that metadata block.
            if heading_text in {"参考文献", "来源与来源类型"}:
                break
            current = ReaderSection(heading=heading_text, paragraphs=[])
            sections.append(current)
            continue
        if current is None:
            if not digest:
                digest = _map_internal_source_tokens(clean_inline(line), source_reference_map)
            else:
                lead = lead or _map_internal_source_tokens(clean_inline(line), source_reference_map)
            continue
        kind = "paragraph"
        if line.startswith("- ") or line.startswith("* "):
            line = re.sub(r"^[-*]\s+", "", line)
            kind = "bullet"
        elif re.match(r"^\d+[.)]\s+", line):
            line = re.sub(r"^\d+[.)]\s+", "", line)
            kind = "number"
        paragraph = _map_internal_source_tokens(clean_inline(line), source_reference_map)
        if paragraph:
            current.paragraphs.append(ReaderParagraph(text=paragraph, kind=kind))
    if sections:
        # The last unheaded paragraph in package markdown is not reliably
        # distinguishable from a conclusion; retaining it as body text is
        # safer than inventing a CTA.
        closing = ""
    return title, digest, lead, sections, closing


def build_reader_article(payload: dict[str, Any]) -> ReaderArticle:
    if not isinstance(payload, dict):
        raise WordExportError("Word export payload must be an object")
    draft = payload.get("draft")
    draft = draft if isinstance(draft, dict) else {}
    package = payload.get("wechatPackage")
    package = package if isinstance(package, dict) else {}
    metadata = package.get("metadata") if isinstance(package.get("metadata"), dict) else {}
    references = _references(payload)
    claim_map = _claim_reference_map(payload, references)

    source_reference_map = _source_reference_map(payload, references)
    # Apply the exact source-token mapping to every reader-visible structured
    # field, not only body paragraphs.  This keeps citations consistent when
    # a provider places a source marker in a title, lead, or heading.
    title = _map_internal_source_tokens(
        re.sub(r"^#{1,6}\s+", "", _first_nonempty(draft.get("title"), metadata.get("title"))),
        source_reference_map,
    )
    digest = _map_internal_source_tokens(
        re.sub(r"^>\s+", "", _first_nonempty(draft.get("digest"), metadata.get("digest"))),
        source_reference_map,
    )
    lead = _map_internal_source_tokens(
        re.sub(r"^>\s+", "", clean_inline(draft.get("lead"))),
        source_reference_map,
    )
    closing = _map_internal_source_tokens(
        re.sub(r"^>\s+", "", clean_inline(draft.get("closingCta"))),
        source_reference_map,
    )
    sections = _draft_sections(draft, claim_map, source_reference_map) if draft else []

    if not title or not sections:
        body_markdown = package.get("bodyMarkdown") or package.get("body")
        if body_markdown:
            fallback_title, fallback_digest, fallback_lead, fallback_sections, fallback_closing = _parse_package_markdown(
                _text(body_markdown), claim_map, source_reference_map
            )
            title = title or fallback_title
            digest = digest or fallback_digest
            lead = lead or fallback_lead
            sections = sections or fallback_sections
            closing = closing or fallback_closing

    if not title:
        raise WordExportError("Word export requires a non-empty draft title")
    if not sections:
        raise WordExportError("Word export requires at least one article section")
    if not digest:
        digest = lead
    if not lead:
        lead = digest

    for label, value in (("title", title), ("digest", digest), ("lead", lead), ("closing", closing)):
        assert_reader_safe(value, label)
    for section in sections:
        assert_reader_safe(section.heading, "article section heading")
        for paragraph in section.paragraphs:
            assert_reader_safe(paragraph.text, "article paragraph")
    return ReaderArticle(title, digest, lead, sections, closing, references)


_THEME_FONT_ATTRIBUTES = (
    "asciiTheme",
    "hAnsiTheme",
    "eastAsiaTheme",
    # The OOXML spelling is ``cstheme`` (lower-case ``t``), but accepting
    # ``csTheme`` as well makes the cleanup robust to producers that emit the
    # camel-case variant.
    "cstheme",
    "csTheme",
)


def _set_explicit_rfonts(rfonts) -> None:
    """Make a run/style font explicit instead of inheriting a theme font.

    Built-in Word styles such as Heading 1 carry ``*Theme`` font attributes
    (usually majorEastAsia/majorHAnsi).  Word gives those theme attributes
    precedence in actual rendering even when ``ascii``/``eastAsia`` are also
    present, which can turn Chinese headings into MS Gothic.  Remove every
    theme selector before setting all four concrete font slots to YaHei.
    """

    for attribute in _THEME_FONT_ATTRIBUTES:
        rfonts.attrib.pop(qn(f"w:{attribute}"), None)
    for attribute in ("ascii", "hAnsi", "eastAsia", "cs"):
        rfonts.set(qn(f"w:{attribute}"), FONT_NAME)


def _set_style_rfonts(style) -> None:
    """Set only the concrete font slots on a style, preserving its size.

    Linked character styles (for example ``Heading1Char``) can override a
    paragraph style's font at render time.  They need the same theme cleanup,
    but their inherited size/weight must remain untouched.
    """

    rpr = style._element.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    _set_explicit_rfonts(rfonts)


def _set_document_default_rfonts(doc: Document) -> None:
    """Neutralise the theme font in ``w:docDefaults`` as a final fallback."""

    styles_root = doc.styles.element
    doc_defaults = styles_root.find(qn("w:docDefaults"))
    rpr_default = doc_defaults.find(qn("w:rPrDefault")) if doc_defaults is not None else None
    rpr = rpr_default.find(qn("w:rPr")) if rpr_default is not None else None
    if rpr is None:
        return
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    _set_explicit_rfonts(rfonts)


def set_font(run, size: float | None = None, color: RGBColor | None = None, *, bold: bool | None = None, italic: bool | None = None, underline: bool | None = None, superscript: bool | None = None, subscript: bool | None = None) -> None:
    run.font.name = FONT_NAME
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    _set_explicit_rfonts(rfonts)
    if size is not None:
        run.font.size = Pt(size)
    if color is not None:
        run.font.color.rgb = color
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if underline is not None:
        run.underline = underline
    if superscript is not None:
        run.font.superscript = superscript
    if subscript is not None:
        run.font.subscript = subscript


def set_style_font(style, size: float = BODY_SIZE_PT, color: RGBColor | None = None, *, bold: bool | None = None) -> None:
    style.font.name = FONT_NAME
    rpr = style._element.get_or_add_rPr()
    rfonts = rpr.rFonts
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.insert(0, rfonts)
    _set_explicit_rfonts(rfonts)
    style.font.size = Pt(size)
    if color is not None:
        style.font.color.rgb = color
    if bold is not None:
        style.font.bold = bold


def _set_first_line_chars(element, chars: int = BODY_FIRST_LINE_CHARS) -> None:
    """Set a true character-based first-line indent on a paragraph/style.

    ``python-docx`` exposes only the twip-valued ``first_line_indent`` API.
    OOXML also supports ``w:firstLineChars`` (hundredths of a character),
    which is the unambiguous representation for a Chinese two-character
    indent.  We add it alongside the 24pt compatibility value used by older
    Word versions and existing consumers.
    """

    ppr = element.get_or_add_pPr()
    indent = ppr.find(qn("w:ind"))
    if indent is None:
        indent = OxmlElement("w:ind")
        ppr.append(indent)
    indent.set(qn("w:firstLineChars"), str(int(chars)))


def set_first_line_chars(paragraph, chars: int = BODY_FIRST_LINE_CHARS) -> None:
    """Apply a character-based first-line indent to one paragraph."""

    _set_first_line_chars(paragraph._p, chars)


def set_style_first_line_chars(style, chars: int = BODY_FIRST_LINE_CHARS) -> None:
    """Apply a character-based first-line indent to a paragraph style."""

    _set_first_line_chars(style._element, chars)


def configure_document(doc: Document) -> None:
    section = doc.sections[0]
    section.page_width = Cm(21)
    section.page_height = Cm(29.7)
    section.top_margin = Cm(2.54)
    section.bottom_margin = Cm(2.54)
    section.left_margin = Cm(2.6)
    section.right_margin = Cm(2.6)
    section.header_distance = Cm(1.25)
    section.footer_distance = Cm(1.25)

    normal = doc.styles["Normal"]
    set_style_font(normal, BODY_SIZE_PT, RGBColor(24, 34, 48))
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(8)
    normal.paragraph_format.line_spacing = BODY_LINE_SPACING
    # Keep the base Normal style neutral.  A character-based first-line
    # indent on Normal is inherited by Heading/List/Reference styles in Word
    # even when their twip ``first_line_indent`` is explicitly set to zero,
    # which visibly shifts headings to the right.  Reader body paragraphs
    # receive the true two-character indent directly in
    # :func:`add_reader_paragraph` (and are therefore unaffected by this
    # neutral base style).
    normal.paragraph_format.first_line_indent = Pt(0)
    normal.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.LEFT

    # The latent default run style is inherited by fields and hyperlinks in
    # some Word versions. Keep it aligned with the explicit styles below so no
    # ASCII-only fallback silently switches the document back to Calibri.
    for style_name in ("Default Paragraph Font", "Hyperlink"):
        try:
            set_style_font(doc.styles[style_name], BODY_SIZE_PT, RGBColor(24, 34, 48))
        except KeyError:
            pass

    title = doc.styles["Title"]
    set_style_font(title, 22, RGBColor(24, 34, 48), bold=True)
    title.paragraph_format.space_before = Pt(0)
    title.paragraph_format.space_after = Pt(18)
    title.paragraph_format.line_spacing = 1.15
    title.paragraph_format.first_line_indent = Pt(0)
    title.paragraph_format.alignment = WD_ALIGN_PARAGRAPH.CENTER

    subtitle = doc.styles["Subtitle"]
    set_style_font(subtitle, 12, RGBColor(100, 116, 139))
    subtitle.paragraph_format.space_before = Pt(0)
    subtitle.paragraph_format.space_after = Pt(10)
    subtitle.paragraph_format.first_line_indent = Pt(0)

    for name, size, before, after in (("Heading 1", 16, 18, 8), ("Heading 2", 14, 14, 6), ("Heading 3", 13, 10, 4)):
        style = doc.styles[name]
        set_style_font(style, size, RGBColor(20, 125, 121), bold=True)
        style.paragraph_format.space_before = Pt(before)
        style.paragraph_format.space_after = Pt(after)
        style.paragraph_format.line_spacing = 1.15
        style.paragraph_format.first_line_indent = Pt(0)
        style.paragraph_format.keep_with_next = True

    for name in ("List Bullet", "List Number"):
        style = doc.styles[name]
        set_style_font(style, BODY_SIZE_PT, RGBColor(24, 34, 48))
        style.paragraph_format.space_after = Pt(6)
        style.paragraph_format.line_spacing = BODY_LINE_SPACING
        style.paragraph_format.left_indent = Cm(0.74)
        style.paragraph_format.first_line_indent = Cm(-0.37)

    styles = doc.styles
    if "Reference" in [style.name for style in styles]:
        reference = styles["Reference"]
    else:
        reference = styles.add_style("Reference", WD_STYLE_TYPE.PARAGRAPH)
    set_style_font(reference, 10.5, RGBColor(100, 116, 139))
    reference.paragraph_format.space_after = Pt(5)
    reference.paragraph_format.line_spacing = 1.15
    reference.paragraph_format.left_indent = Cm(0.74)
    reference.paragraph_format.first_line_indent = Cm(-0.74)

    # Heading paragraph styles are linked to character styles in the stock
    # Word template.  Those linked styles and the document defaults carry
    # theme font selectors that can override explicit YaHei in real Word
    # rendering, so clean them after configuring the reader styles.
    linked_style_ids = {
        "TitleChar",
        "SubtitleChar",
        "Heading1Char",
        "Heading2Char",
        "Heading3Char",
        "HeaderChar",
        "FooterChar",
    }
    for style in doc.styles:
        if getattr(style, "style_id", None) in linked_style_ids:
            _set_style_rfonts(style)
    _set_document_default_rfonts(doc)

    header = section.header.paragraphs[0]
    header.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    header.paragraph_format.first_line_indent = Pt(0)
    set_font(header.add_run("公众号文章工作台"), 9, RGBColor(100, 116, 139))

    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer.paragraph_format.first_line_indent = Pt(0)
    set_font(footer.add_run("第 "), 9, RGBColor(100, 116, 139))
    add_page_number(footer)
    set_font(footer.add_run(" 页"), 9, RGBColor(100, 116, 139))


def add_page_number(paragraph) -> None:
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instruction = OxmlElement("w:instrText")
    instruction.set(qn("xml:space"), "preserve")
    instruction.text = " PAGE "
    separate = OxmlElement("w:fldChar")
    separate.set(qn("w:fldCharType"), "separate")
    text = OxmlElement("w:t")
    text.text = "1"
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.extend([begin, instruction, separate, text, end])
    set_font(run, 9, RGBColor(100, 116, 139))


def add_hyperlink(paragraph, text: str, url: str, *, size: float = 10.5) -> None:
    relationship = paragraph.part.relate_to(url, RT.HYPERLINK, is_external=True)
    hyperlink = OxmlElement("w:hyperlink")
    hyperlink.set(qn("r:id"), relationship)
    run = OxmlElement("w:r")
    rpr = OxmlElement("w:rPr")
    rfonts = OxmlElement("w:rFonts")
    for attribute in ("ascii", "hAnsi", "eastAsia", "cs"):
        rfonts.set(qn(f"w:{attribute}"), FONT_NAME)
    rpr.append(rfonts)
    size_node = OxmlElement("w:sz")
    size_node.set(qn("w:val"), str(int(size * 2)))
    rpr.append(size_node)
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "147D79")
    rpr.append(color)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    rpr.append(underline)
    run.append(rpr)
    text_node = OxmlElement("w:t")
    text_node.text = text
    run.append(text_node)
    hyperlink.append(run)
    paragraph._p.append(hyperlink)


def add_inline_runs(paragraph, text: str, *, size: float = BODY_SIZE_PT, color: RGBColor = RGBColor(24, 34, 48), italic: bool = False) -> None:
    """Render a small safe Markdown subset and scientific superscripts."""

    pieces = re.split(r"(https?://[^\s<>()\u3002，；）】]+|\*\*[^*]+\*\*|(?<!\*)\*[^*]+\*(?!\*)|`[^`]+`)", text)
    for piece in pieces:
        if not piece:
            continue
        if URL_PATTERN.fullmatch(piece):
            add_hyperlink(paragraph, piece, piece, size=size)
            continue
        bold = piece.startswith("**") and piece.endswith("**")
        emph = piece.startswith("*") and piece.endswith("*") and not bold
        code = piece.startswith("`") and piece.endswith("`")
        if bold or emph or code:
            piece = piece[2:-2] if bold else piece[1:-1]
        cursor = 0
        # Render common ``10^-4``/``H_2`` notation as true runs.  Unmatched
        # carets/underscores remain ordinary text, avoiding data loss.
        pattern = re.compile(r"(?P<base>[A-Za-z\u4e00-\u9fff0-9]+)(?:\^(?P<sup>[+-]?\d+)|_(?P<sub>\d+))")
        for match in pattern.finditer(piece):
            if match.start() > cursor:
                run = paragraph.add_run(piece[cursor:match.start()])
                set_font(run, size, color, bold=bold, italic=(italic or emph), superscript=False, subscript=False)
            base = paragraph.add_run(match.group("base"))
            set_font(base, size, color, bold=bold, italic=(italic or emph))
            exponent = match.group("sup") or match.group("sub")
            exponent_run = paragraph.add_run(exponent)
            set_font(
                exponent_run,
                max(size - 2, 8),
                color,
                bold=bold,
                italic=(italic or emph),
                superscript=bool(match.group("sup")),
                subscript=bool(match.group("sub")),
            )
            cursor = match.end()
        if cursor < len(piece):
            run = paragraph.add_run(piece[cursor:])
            set_font(run, size, color, bold=bold, italic=(italic or emph))


def add_reader_paragraph(doc: Document, text: str, *, style: str = "Normal", italic: bool = False):
    paragraph = doc.add_paragraph(style=style)
    if style == "Normal":
        paragraph.paragraph_format.first_line_indent = Pt(BODY_FIRST_LINE_PT)
        paragraph.paragraph_format.line_spacing = BODY_LINE_SPACING
        set_first_line_chars(paragraph)
    else:
        paragraph.paragraph_format.first_line_indent = Pt(0)
    add_inline_runs(paragraph, text, italic=italic)
    return paragraph


def build_docx(article: ReaderArticle) -> bytes:
    doc = Document()
    configure_document(doc)

    doc.core_properties.title = article.title
    doc.core_properties.subject = "中文文章"
    doc.core_properties.author = "公众号文章工作台"
    doc.core_properties.comments = "依据公开资料整理。"

    title = doc.add_paragraph(style="Title")
    title.paragraph_format.first_line_indent = Pt(0)
    add_inline_runs(title, article.title, size=22, color=RGBColor(24, 34, 48))

    if article.digest:
        heading = doc.add_heading("摘要", level=2)
        heading.paragraph_format.first_line_indent = Pt(0)
        add_reader_paragraph(doc, article.digest)

    if article.lead and article.lead != article.digest:
        add_reader_paragraph(doc, article.lead, italic=True)

    for section in article.sections:
        heading = doc.add_heading(section.heading, level=1)
        heading.paragraph_format.first_line_indent = Pt(0)
        for paragraph in section.paragraphs:
            if paragraph.kind == "bullet":
                p = doc.add_paragraph(style="List Bullet")
                p.paragraph_format.first_line_indent = Cm(-0.37)
                add_inline_runs(p, paragraph.text)
            elif paragraph.kind == "number":
                p = doc.add_paragraph(style="List Number")
                p.paragraph_format.first_line_indent = Cm(-0.37)
                add_inline_runs(p, paragraph.text)
            else:
                add_reader_paragraph(doc, paragraph.text)

    if article.closing:
        add_reader_paragraph(doc, article.closing)

    heading = doc.add_heading("参考文献", level=1)
    heading.paragraph_format.first_line_indent = Pt(0)
    if not article.references:
        empty = doc.add_paragraph(style="Reference")
        empty.paragraph_format.first_line_indent = Pt(0)
        add_inline_runs(empty, "暂无可展示的参考文献。", size=10.5, color=RGBColor(100, 116, 139))
    else:
        for reference in article.references:
            p = doc.add_paragraph(style="Reference")
            p.paragraph_format.first_line_indent = Cm(-0.74)
            p.paragraph_format.left_indent = Cm(0.74)
            label = reference.label()
            link = reference.link
            if link and label.endswith(link + "."):
                prefix = label[: -(len(link) + 1)]
                add_inline_runs(p, prefix, size=10.5, color=RGBColor(100, 116, 139))
                p.add_run(" ")
                add_hyperlink(p, link, link, size=10.5)
                p.add_run(".")
            else:
                add_inline_runs(p, label, size=10.5, color=RGBColor(100, 116, 139))

    output = io.BytesIO()
    doc.save(output)
    return output.getvalue()


def export_payload(payload: dict[str, Any]) -> bytes:
    article = build_reader_article(payload)
    return build_docx(article)


def main() -> int:
    try:
        raw = sys.stdin.buffer.read()
        payload = json.loads(raw.decode("utf-8")) if raw else {}
        sys.stdout.buffer.write(export_payload(payload))
        return 0
    except Exception as error:  # pragma: no cover - exercised by Node wrapper
        print(f"{getattr(error, 'code', 'word_export_failed')}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
