"""A document as text to edit: the Markdown of what the reader reads, for one that came as a page (an arXiv paper, a web
page, an article from Wikipedia or Europe PMC), not as Markdown (local.text_of: a Markdown file's, a converted file's).

It is written from the document as parse.py reads it (store.parsed), so it holds what the reader shows and nothing of
the page around it, and every source is written alike: headings with their numbers, paragraphs and list items with
their emphasis, formulas in LaTeX ($...$, display ones numbered by \\tag), links, footnotes. What Markdown has no words
for stays as the page has it, in HTML (a table, a figure's pictures, the references): a figure is a <figure>, its
caption in Markdown between the tags. An id stays where something links to it, so a reference still reaches its
figure, formula or entry. Read back (markdown.to_html, semantic.normalize), unchanged, it is the same document: the
same paragraphs with the same words and ids, the same formulas, citations and references (tests/test_edit_any.py).
"""
import re
from array import array
from html import unescape
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from . import markdown as md, notes
from .fetch import image_name
from .semantic import HEAD_NUM, _label_id

MARKS = {"ltx_font_bold": "**", "ltx_font_italic": "*"}
# what begins a line that Markdown would read as its own: a heading, a list item, a quotation, a rule, a table
LINE_START = re.compile(r"^(#{1,6}(?:\s|$)|[-+*](?:\s|$)|\d+[.)](?:\s|$)|>|={3,}|-{3,}|\|)")


def _esc(t):
    """Words as Markdown reads them as words."""
    t = re.sub(r"([\\`*\[\]<$])", r"\\\1", t)
    return re.sub(r"(?:^|(?<=\W))_|_(?=\W|$)", r"\\_", t)


def _line(text):
    return "\\" + text if LINE_START.match(text) else text


class _Writer:
    def __init__(self, doc, pictures=None):
        self.doc, self.notes, self.pictures = doc, [], pictures
        self.base = doc["meta"].get("html_url") or ""   # (an arXiv page's figures are named from it: fetch.fetch_images)
        html ="".join(a["html"] for a in doc["atoms"].values()) + "".join(b.get("html") or "" for b in doc["blocks"])
        self.linked = set(re.findall(r'href="#([^"]+)"', html + (doc.get("bib") or "")))
        # a numbered formula named by its label (\\label: eq-<id>), a link to it, or to a row of it, going there
        self.eqs = {x: _label_id(b["id"]) for b in doc["blocks"] if b["k"] == "eq" and b.get("id")
                    for x in [b["id"], *re.findall(r'\sid="([^"]+)"', b["html"])] if x in self.linked}

    def html(self, html):
        """HTML as an edit shows it: no style, title or data, an id only where something links to it, pictures by their
        whole address, and no blank line (one would end it in Markdown)."""
        soup = BeautifulSoup(html, "lxml")
        root = soup.body or soup
        for el in root.find_all(True):
            for k in list(el.attrs):
                if k in ("style", "title") or k.startswith("data-") or k == "id" and el[k] not in self.linked:
                    del el[k]
            if el.name == "img" and el.get("src") and not re.match(r"[a-z][\w+.-]*:|img/", el["src"]):
                el["src"] = self.picture(el["src"])
        return re.sub(r"\n\s*\n+", "\n", root.decode_contents().strip())

    def picture(self, src):
        """A page's picture named from its address (an arXiv paper's): the copy the reader keeps beside it, or where it is."""
        name = image_name(src)
        kept = next((f for f in (self.pictures / name, self.pictures / f"{name}.webp") if f.is_file()), None) if self.pictures else None
        return f"img/{kept.name}" if kept else urljoin(self.base, src) if self.base else src

    def words(self, toks):
        """A unit's tokens as a line of Markdown: a run of emphasis marked by its asterisks, or by its class where they
        would not be read as such."""
        out, run, font = [], [], None

        def close():
            s = "".join(run)
            core = s.rstrip(" ")
            f = set((font or "").split())
            if core and f and f <= set(MARKS) and re.match(r"\w", core) and re.search(r"[\w)$]$", core):
                m = "".join(MARKS[x] for x in sorted(f))
                core = f"{m}{core}{m[::-1]}"
            elif core and f:
                core = f'<span class="{" ".join(sorted(f))}">{core}</span>'
            out.append(core + s[len(s.rstrip(" ")):])
            run.clear()

        for k, tk in enumerate(toks):
            if "a" in tk:   # (in the run it is in; a formula against a digit is not read as one between dollars: $5)
                digit = (k and not toks[k - 1].get("s") and re.search(r"\d$", toks[k - 1].get("t", ""))
                         or not tk.get("s") and k + 1 < len(toks) and re.match(r"\d", toks[k + 1].get("t", "")))
                piece, f = self.atom(self.doc["atoms"][tk["a"]], bool(digit)), font
            else:
                piece, f = _esc(tk["t"]), tk.get("f")
            if f != font:
                close()
                font = f
            run.append(piece + (" " if tk.get("s") else ""))
        close()
        return "".join(out).strip()

    def atom(self, a, digit=False):
        if a["kind"] == "math":
            return f"${a['alt']}$" if a.get("alt") and not digit else self.html(a["html"])
        if a["kind"] == "ref":
            el = BeautifulSoup(a["html"], "lxml").find("a")
            href = el.get("href") if el else None
            if href and href.startswith("#") and href[1:] in self.eqs:
                href = "#" + self.eqs[href[1:]]
            return f"[{_esc(a['text'])}]({href})" if href else _esc(a["text"])
        if a["kind"] == "note":
            note = BeautifulSoup(a["html"], "lxml")
            body = note.find(class_="ltx_note_content") or note
            for m in body.find_all(class_="ltx_note_mark"):
                m.decompose()
            self.notes.append(_esc(re.sub(r"\s+", " ", body.get_text(" ")).strip()))
            return f"[^{len(self.notes)}]"
        return self.html(a["html"])

    def equation(self, b):
        """A display formula in LaTeX: its rows, the parts of each aligned, and its number."""
        soup = BeautifulSoup(b["html"], "lxml")
        rows = [[m.get("alttext") or "" for m in tr.find_all("math")] for tr in soup.find_all("tr")] or [[m.get("alttext") or "" for m in soup.find_all("math")]]
        rows = [r for r in rows if r]
        latex = " \\\\ ".join(" & ".join(r) for r in rows)
        if len(rows) > 1 or any(len(r) > 1 for r in rows):
            latex = "\\begin{aligned}" + latex + "\\end{aligned}"
        tag = soup.find(class_="ltx_tag_equation")
        number = tag.get_text("").strip().strip("()") if tag else ""
        return ("$$\n" + latex + (f" \\tag{{{number}}}" if number else "") +
                (f" \\label{{{b['id']}}}" if _label_id(b.get("id") or "") in self.eqs.values() else "") + "\n$$")

    def figure(self, b):
        units = self.doc["units"]
        cap = self.words(units[b["cap"]]["toks"]) if b.get("cap") else ""
        tag = f'<span class="ltx_tag">{b["label"]}: </span>' if b.get("label") else ""
        fid = f' id="{b["id"]}"' if b.get("id") in self.linked else ""
        body = self.html(b["html"])
        cap = f'<figcaption class="ltx_caption">{tag}\n\n{cap}\n\n</figcaption>\n' if cap or tag else ""
        return f"<figure{fid}>\n{body}\n{cap}</figure>" if b["kind"] == "figure" else f"<figure{fid}>\n{cap}{body}\n</figure>"

    def write(self):
        doc = self.doc
        chunks, units = {c["id"]: c for c in doc["chunks"]}, doc["units"]
        out, in_list = [], None
        for b in doc["blocks"]:
            item = b["k"] == "u" and units[b["u"]].get("role") == "item"
            if b["k"] == "h":
                c = chunks[b["chunk"]]
                level, num = min(6, max(1, c.get("level") or 2)), c.get("num") or ""
                m = HEAD_NUM.match(f"{num} {c['title']}") if num else None
                if num and not (m and m.group(1).rstrip(".") == num):   # (a number not read as one: Appendix A)
                    out.append(f'<h{level}><span class="ltx_tag">{num} </span>{self.html(c["html"])}</h{level}>')
                elif num or c["title"] or out:   # (the text before the first heading: read again as the untitled section it is)
                    out.append("#" * level + " " + f"{num} {c['title']}".strip())
            elif item:
                u = units[b["u"]]
                mark = u.get("marker") or ""
                line = "    " * (u.get("depth") or 0) + (mark if re.fullmatch(r"\d+[.)]", mark) else "-") + " " + _line(self.words(u["toks"]))
                if in_list is not None and in_list == u.get("list"):
                    out[-1] += "\n" + line
                else:
                    out.append(line)
            elif b["k"] == "u":
                out.append(_line(self.words(units[b["u"]]["toks"])))
            elif b["k"] == "fig":
                out.append(self.figure(b))
            elif b["k"] == "eq":
                out.append(self.equation(b))
            elif b["k"] == "raw" and b.get("chunk"):   # (none: the page's own, outside its sections)
                body = self.html(b["html"])   # (a picture alone: one with no caption, as a figure says so)
                out.append(f"<figure>\n{body}\n</figure>" if re.fullmatch(r"<img[^>]*>", body) else body)
            elif b["k"] == "box":   # a theorem, a proof: its paragraphs in Markdown between its tags
                cls = "ltx_proof" if b["kind"] == "proof" else f"ltx_theorem ltx_theorem_{b['kind']}"
                bid = f' id="{b["id"]}"' if b["id"] in self.linked else ""
                out.append(f'<div class="{cls}"{bid}>' + (f'\n<h6 class="ltx_title">{self.html(b["title"])}</h6>' if b.get("title") else ""))
            elif b["k"] == "box_end":
                out.append("</div>")
            in_list = units[b["u"]].get("list") if item else None
        if doc.get("bib"):
            out += ["## References", self.html(doc["bib"])]
        out += [f"[^{k}]: {n}" for k, n in enumerate(self.notes, 1)]
        return "\n\n".join(x for x in out if x.strip()) + "\n"


def markdown(doc, pictures=None):
    """The Markdown of a document as parse.py reads it (store.parsed); pictures: the folder its figures are kept in."""
    return _Writer(doc, pictures).write()


_LINK_DEST = r"\((?:\\.|[^()\\\n]|\((?:\\.|[^()\\\n])*\))*\)|\[[^\]\n]*\]"
_MARKUP = re.compile(
    rf"""
    (?P<space>\s+|<br\s*/?>)
    | \\\((?P<math>[^\n]+?)\\\)
    | <(?P<autolink>(?:https?://|mailto:)[^<>\s]+)>
    | (?P<footnote>\[\^[^\]\n]+\])
    | (?P<escape>\\[!-/:-@\[-\x60{{-~])
    | (?P<entity>&(?:\#[0-9]+|\#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]+);)
    | <!--[\s\S]*?-->
    | <(?P<element>script|style|pre|template|h[1-6])\b[^>]*>[\s\S]*?</(?P=element)\s*>
    | </?[A-Za-z][\w:-]*(?=[\s/>])(?:"[^"]*"|'[^']*'|[^"'<>])*>
    | !?\[(?=[^\]\n]*\](?:{_LINK_DEST}))
    | \](?:{_LINK_DEST})
    | (?m:^[ \t]*(?:>[ \t]*)+)
    """,
    re.I | re.X,
)
_EMPHASIS = re.compile(r"(?<!\\)(\*{1,3}|(?<!\w)_{1,3}|~~|\x60+)(?=\S)([^\n]+?)(?<=\S)\1")


def _source_chars(text):
    """Searchable prose and the original character range of each character, with Markdown syntax skipped."""
    lines = [0] + [m.end() for m in re.finditer("\n", text)] + [len(text)]
    env = {}
    blocks = {"heading_open", "front_matter", "fence", "code_block", "math_block", "math_block_label", "hr"}
    omitted, in_footnotes = [], False
    for t in md._md().parse(text, env):
        in_footnotes = in_footnotes or t.type == "footnote_block_open"
        if t.map and (in_footnotes or t.type in blocks):
            omitted.append((lines[t.map[0]], lines[t.map[1]]))
    for ref in env.get("references", {}).values():
        a, b = ref["map"]
        omitted.append((lines[a], lines[b]))
    footnotes = env.get("footnotes", {}).get("refs", {})
    emphasis, delimiters = [], set()
    chars, starts, ends = [], array("I"), array("I")

    def add(value, start, end):
        for c in value:
            if c.isspace():
                if chars and chars[-1] == " ":
                    ends[-1] = end
                    continue
                c = " "
            chars.append(c)
            starts.append(start)
            ends.append(end)

    def literal(start, end):
        for i in range(start, end):
            if i not in delimiters:
                add(text[i], i, i + 1)

    def project(start, end):
        for m in _EMPHASIS.finditer(text, start, end):
            emphasis.append(m)
            delimiters.update(range(m.start(), m.start(2)))
            delimiters.update(range(m.end(2), m.end()))
        at = start
        for m in _MARKUP.finditer(text, start, end):
            literal(at, m.start())
            if m.group("space"):
                add(" ", m.start(), m.end())
            elif m.group("math"):
                add("$", m.start(), m.start("math"))
                start, end_math = m.span("math")
                while start < end_math and text[start].isspace():
                    start += 1
                while end_math > start and text[end_math - 1].isspace():
                    end_math -= 1
                for i in range(start, end_math):
                    add(text[i], i, i + 1)
                add("$", m.end("math"), m.end())
            elif m.group("autolink"):
                literal(*m.span("autolink"))
            elif m.group("footnote") and f":{m[0][2:-1]}" not in footnotes:
                literal(*m.span())
            elif m.group("escape"):
                add(m[0][1], m.start(), m.end())
            elif m.group("entity"):
                add(unescape(m[0]), m.start(), m.end())
            at = m.end()
        literal(at, end)

    at = 0
    for start, end in sorted(omitted):
        if start > at:
            project(at, start)
        at = max(at, end)
    project(at, len(text))
    return "".join(chars), starts, ends, emphasis


def selection_span(text, doc, start, end):
    """Locate a selection by its original units and offsets. Both reading directions must locate the same units."""
    units = {uid: notes._spans(u["toks"], doc["atoms"])[0] for uid, u in doc["units"].items()}
    for point, key in ((start, "from"), (end, "to")):
        plain = units.get(point["unit"])
        if plain != point["expected"] or not plain or not 0 <= point[key] <= len(plain):
            return None

    source, starts, ends, emphasis = _source_chars(text)
    ids = list(units)
    first, last = ids.index(start["unit"]), ids.index(end["unit"])
    if first > last:
        return None

    def locate(reverse):
        at = len(source) if reverse else 0
        found = {}
        for i in (range(len(ids) - 1, first - 1, -1) if reverse else range(last + 1)):
            uid = ids[i]
            value = units[uid]
            if not value:
                continue
            match = source.rfind(value, 0, at) if reverse else source.find(value, at)
            if match >= 0:
                at = match if reverse else match + len(value)
                if i in (first, last):
                    found[uid] = match
        return found

    forward = locate(False)
    if len(forward) != len({start["unit"], end["unit"]}) or forward != locate(True):
        return None
    a = forward[start["unit"]] + start["from"]
    b = forward[end["unit"]] + end["to"]
    if a >= b:
        return None
    a, b = starts[a], ends[b - 1]
    # A selection that crosses one delimiter and covers all its contents includes the matching delimiter.
    for m in emphasis:
        if a == m.start(2) and b >= m.end():
            a = m.start()
        if b == m.end(2) and a <= m.start():
            b = m.end()
    return a, b
