"""Assemble the single-file artifact page: src/shell.html + <script>(lessons.js + runtime.js)."""
from pathlib import Path

root = Path(__file__).parent
src = root / "src"
page = (src / "shell.html").read_text()
script = (src / "lessons.js").read_text() + "\n" + (src / "runtime.js").read_text()
out = root / "dist" / "on-air-english.html"
out.parent.mkdir(exist_ok=True)
out.write_text(page + "<script>\n" + script + "</script>\n")
print(out, out.stat().st_size, "bytes")
