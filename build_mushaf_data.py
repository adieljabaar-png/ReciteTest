#!/usr/bin/env python3
"""
build_mushaf_data.py  --  turn QUL (qul.tarteel.ai) downloads into the single
`mushaf13.json` file that the Recite app's 13-line Quran reader loads.

You need two downloads from https://qul.tarteel.ai (free account):
  1. Mushaf layout   ->  "Indopak 13 lines - Taj company"  (layout id 23, 847 pages)
                         (SQLite or JSON export; table `pages`)
  2. Quran script    ->  the word-by-word IndoPak script that the layout page lists
                         as compatible (SQLite or JSON export; table `words`)

Usage:
  python3 build_mushaf_data.py --layout layout.sqlite --words words.sqlite -o mushaf13.json

Nothing in the Quran text is altered: every diacritic, waqf sign and tajweed
mark in the QUL script is copied through byte-for-byte.
"""
import argparse, json, os, re, sqlite3, sys, datetime

LINE_TYPES = {"ayah": 0, "surah_name": 1, "basmallah": 2, "basmalah": 2, "bismillah": 2}

# Arabic combining marks (harakat, tanween, shadda, sukun/jazm forms, madd,
# small high/low letters, waqf signs, small waw/yeh ...).
_MARK_RE = re.compile(u"[ؐ-ًؚ-ٰٟۖ-ۜ۟-۪ۨ-ۭ࣓-ࣿ]")
_END_RE = re.compile(u"^(?:\u06DD?[0-9\u0660-\u0669\u06F0-\u06F9]+|[\uE000-\uF8FF]+)$")
_LETTER_RE = re.compile(u"[ء-غف-يٮ-ۓۺ-ۼ]")


def die(msg):
    sys.stderr.write("ERROR: " + msg + "\n")
    sys.exit(1)


# ----------------------------------------------------------------- readers
def _sqlite_rows(path):
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    tables = [r[0] for r in con.execute("select name from sqlite_master where type='table'")]
    out = {}
    for t in tables:
        try:
            out[t] = [dict(r) for r in con.execute('select * from "%s"' % t.replace('"', ''))]
        except sqlite3.Error:
            pass
    con.close()
    return out


def _load_any(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".sqlite", ".sqlite3", ".db"):
        return ("sqlite", _sqlite_rows(path))
    with open(path, "r", encoding="utf-8") as fh:
        return ("json", json.load(fh))


def _first_present(d, names):
    for n in names:
        if n in d and d[n] is not None:
            return d[n]
    return None


def _truthy(v):
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "t", "yes")
    return bool(v)


def read_layout(path):
    kind, data = _load_any(path)
    rows = None
    if kind == "sqlite":
        for name, tbl in data.items():
            if tbl and "page_number" in tbl[0] and "line_number" in tbl[0]:
                rows = tbl
                break
        if rows is None:
            die("No table with page_number/line_number found in %s (tables: %s)" % (path, ", ".join(data)))
    else:
        if isinstance(data, dict):
            if isinstance(data.get("pages"), list):
                data = data["pages"]
            elif isinstance(data.get("pages"), dict):
                data = data["pages"]
            if isinstance(data, dict):
                flat = []
                for pk, lines in data.items():
                    if isinstance(lines, list):
                        for ln in lines:
                            ln = dict(ln)
                            ln.setdefault("page_number", int(pk))
                            flat.append(ln)
                data = flat
        if not isinstance(data, list):
            die("Unrecognised layout JSON structure in %s" % path)
        rows = data
    pages = {}
    for r in rows:
        p = _first_present(r, ["page_number", "page"])
        l = _first_present(r, ["line_number", "line"])
        t = str(_first_present(r, ["line_type", "type"]) or "ayah").strip().lower()
        if p is None or l is None:
            continue
        if t not in LINE_TYPES:
            die("Unknown line_type %r on page %s line %s" % (t, p, l))
        first = _first_present(r, ["first_word_id", "first_word"])
        last = _first_present(r, ["last_word_id", "last_word"])
        if isinstance(first, str) and first.strip() == "":
            first = None
        if isinstance(last, str) and last.strip() == "":
            last = None
        sn = _first_present(r, ["surah_number", "surah"])
        pages.setdefault(int(p), []).append((
            int(l), LINE_TYPES[t], 1 if _truthy(r.get("is_centered", 0)) else 0,
            int(first) if first is not None else 0, int(last) if last is not None else 0,
            int(sn) if sn not in (None, "") else 0))
    if not pages:
        die("Layout file contained no rows.")
    return pages


def read_words(path):
    kind, data = _load_any(path)
    rows = None
    if kind == "sqlite":
        for name, tbl in data.items():
            if tbl and ("word_index" in tbl[0] or "id" in tbl[0]) and ("text" in tbl[0] or "word" in tbl[0]):
                rows = tbl
                break
        if rows is None:
            die("No words table found in %s (tables: %s)" % (path, ", ".join(data)))
    else:
        if isinstance(data, dict) and isinstance(data.get("words"), (list, dict)):
            data = data["words"]
        if isinstance(data, dict):
            tmp = []
            for k, v in data.items():
                if isinstance(v, str):
                    v = {"text": v}
                v = dict(v)
                v.setdefault("word_key", k)
                tmp.append(v)
            data = tmp
        if not isinstance(data, list):
            die("Unrecognised words JSON structure in %s" % path)
        rows = data
    words = {}
    for r in rows:
        text = _first_present(r, ["text", "word", "text_indopak", "text_indopak_nastaleeq"])
        if text is None:
            continue
        idx = _first_present(r, ["word_index", "id", "index"])
        s = _first_present(r, ["surah", "surah_number", "chapter_id"])
        a = _first_present(r, ["ayah", "ayah_number", "verse_number"])
        key = _first_present(r, ["word_key", "location", "verse_key", "key"])
        if (s is None or a is None) and key:
            parts = re.split(r"[:_]", str(key))
            if len(parts) >= 2:
                s, a = parts[0], parts[1]
        if idx is None or s is None or a is None:
            die("A word row is missing word_index/surah/ayah: %r" % (r,))
        words[int(idx)] = (int(s), int(a), str(text))
    if not words:
        die("Words file contained no rows.")
    return words


# ------------------------------------------------------------------- build
def build(layout_path, words_path, name):
    pages = read_layout(layout_path)
    words = read_words(words_path)

    page_nums = sorted(pages)
    if page_nums != list(range(1, len(page_nums) + 1)):
        die("Page numbers are not contiguous from 1 (first %d, last %d, count %d)." % (page_nums[0], page_nums[-1], len(page_nums)))

    ids = sorted(words)
    base = ids[0]
    top = ids[-1]
    word_list = []
    missing = 0
    for i in range(base, top + 1):
        w = words.get(i)
        if w is None:
            missing += 1
            word_list.append([0, 0, ""])
        else:
            word_list.append([w[0], w[1], w[2]])
    if missing:
        sys.stderr.write("WARNING: %d gaps in word_index sequence (kept as empty words).\n" % missing)

    out_pages = []
    line_counts = {}
    surah_lines = 0
    for p in page_nums:
        lines = sorted(pages[p], key=lambda t: t[0])
        line_counts[p] = len(lines)
        row = []
        for (l, t, c, f, la, sn) in lines:
            if t == 0:
                if not (base <= f <= la <= top):
                    die("Page %d line %d references words %d-%d outside the script (%d-%d)." % (p, l, f, la, base, top))
            if t == 1:
                surah_lines += 1
                if not 1 <= sn <= 114:
                    die("Page %d line %d: surah_name line has surah_number %r" % (p, l, sn))
            row.append([t, c, f, la, sn])
        out_pages.append(row)

    # sanity reports --------------------------------------------------------
    all_text = "".join(w[2] for w in word_list)
    letters = len(_LETTER_RE.findall(all_text))
    marks = len(_MARK_RE.findall(all_text))
    ratio = marks / letters if letters else 0
    common = max(set(line_counts.values()), key=list(line_counts.values()).count)
    odd = [p for p, n in line_counts.items() if n != common]
    sys.stderr.write("Pages: %d   lines/page (most common): %d   words: %d\n" % (len(page_nums), common, len(word_list)))
    sys.stderr.write("Letters: %d   diacritic/tajweed marks: %d   (%.2f marks per letter)\n" % (letters, marks, ratio))
    sys.stderr.write("Surah-name lines: %d (expected 114)\n" % surah_lines)
    ends = len([w for w in word_list if _END_RE.match(w[2])])
    sys.stderr.write("Ayah-end marker words: %d (a full Quran has 6236 verses)\n" % ends)
    if abs(ends - 6236) > 120:
        sys.stderr.write("WARNING: end-of-ayah markers were not recognised as numbers. The reader draws the ring "
                         "around words that are just digits; check how this script writes ayah numbers.\n")
    if odd:
        sys.stderr.write("NOTE: %d page(s) do not have %d lines, e.g. %s\n" % (len(odd), common, odd[:8]))
    if ratio < 0.6:
        sys.stderr.write("WARNING: very few diacritics per letter. This looks like a plain/simple script, "
                         "not a fully marked IndoPak script. Tajweed signs will be missing on screen.\n")
    if surah_lines != 114:
        sys.stderr.write("WARNING: expected 114 surah_name lines.\n")

    return {
        "v": 1,
        "meta": {
            "name": name, "pages": len(page_nums), "lines": common, "words": len(word_list),
            "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "base": base,
        "words": word_list,
        "pages": out_pages,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--layout", required=True, help="QUL mushaf layout export (.sqlite/.db/.json)")
    ap.add_argument("--words", required=True, help="QUL word-by-word script export (.sqlite/.db/.json)")
    ap.add_argument("-o", "--out", default="mushaf13.json")
    ap.add_argument("--name", default="IndoPak 13 lines (Taj)")
    a = ap.parse_args()
    data = build(a.layout, a.words, a.name)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))
    sys.stderr.write("Wrote %s (%.1f MB)\n" % (a.out, os.path.getsize(a.out) / 1048576.0))


if __name__ == "__main__":
    main()
