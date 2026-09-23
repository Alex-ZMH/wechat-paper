"""Extract public source text using stdlib HTML parsing and optional existing pypdf."""
import io
import json
import re
import sys
from html.parser import HTMLParser


class TextParser(HTMLParser):
    ABSTRACT_META_NAMES = {"citation_abstract", "dc.description"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden = 0
        self.parts = []
        self.abstracts = []
        self._abstract_seen = set()

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript", "template"):
            self.hidden += 1
            return
        if tag != "meta" or self.hidden:
            return
        attributes = {name.lower(): value for name, value in attrs if name}
        name = (attributes.get("name") or "").strip().lower()
        if name not in self.ABSTRACT_META_NAMES:
            return
        # HTMLParser already decodes character references in attribute values
        # once. Do not unescape again: a literal "&amp;lt;" in the source
        # must remain "&lt;" in the extracted text.
        value = (attributes.get("content") or "").strip()
        if value and value not in self._abstract_seen:
            self._abstract_seen.add(value)
            self.abstracts.append(value)

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "template"):
            self.hidden = max(0, self.hidden - 1)
        if not self.hidden:
            self.parts.append(" ")

    def handle_data(self, value):
        if not self.hidden:
            self.parts.append(value)


raw = sys.stdin.buffer.read()
if raw.startswith(b"%PDF-"):
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.stderr.write("PDF text extraction is unavailable; install no packages automatically.\n")
        sys.exit(2)
    reader = PdfReader(io.BytesIO(raw))
    text = "\n".join(f"[Page {i + 1}] " + (page.extract_text() or "") for i, page in enumerate(reader.pages))
else:
    head = raw[:8192].decode("ascii", errors="ignore")
    charset = re.search(r"charset\s*=\s*[\"']?([\w-]+)", head, re.I)
    encoding = charset.group(1) if charset else (sys.argv[1] if len(sys.argv) > 1 else "utf-8")
    try:
        html = raw.decode(encoding, errors="replace")
    except LookupError:
        html = raw.decode("utf-8", errors="replace")
    parser = TextParser()
    parser.feed(html)
    text = " ".join(parser.parts + parser.abstracts)
sys.stdout.buffer.write(json.dumps({"text": text}, ensure_ascii=False).encode("utf-8"))
