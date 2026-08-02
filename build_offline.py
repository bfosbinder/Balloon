#!/usr/bin/env python3
"""
Build balloon-offline.html — the same tool with PDF.js and pdf-lib inlined,
plus a Content-Security-Policy that names no network origin at all.

    python3 build_offline.py

Expects the library files under vendor/ (see fetch_libs.sh). Reads balloon.html,
writes balloon-offline.html. Re-run after any edit to balloon.html.
"""
import pathlib
import re
import sys

HERE = pathlib.Path(__file__).parent
SRC = HERE / "balloon.html"
OUT = HERE / "balloon-offline.html"

LIBS = {
    "pdf":       HERE / "vendor/package/build/pdf.min.js",
    "pdfworker": HERE / "vendor/package/build/pdf.worker.min.js",
    "pdflib":    HERE / "vendor/package/dist/pdf-lib.min.js",
}

# No http: or https: origin appears anywhere in this policy, so the browser
# refuses any outbound request and logs a violation if one is ever attempted.
CSP = (
    "default-src 'none'; "
    "script-src 'unsafe-inline' blob:; "
    "worker-src blob:; "
    "style-src 'unsafe-inline'; "
    "img-src data: blob:; "
    "font-src data:; "
    "connect-src blob: data:; "
    "base-uri 'none'; "
    "form-action 'none'"
)

BANNER = """<!--
  Balloon — offline build.
  PDF.js 3.11.174 and pdf-lib 1.17.1 are inlined below; nothing is fetched.
  The Content-Security-Policy names no network origin, so the browser will
  block any outbound request from this page and log it to the console.
  Built from balloon.html by build_offline.py — edit that file, not this one.
-->
"""


def check_inlinable(name, text):
    """A raw <script> block ends at the first </script; HTML also treats <!-- specially."""
    for bad in ("</script", "<!--"):
        if bad in text:
            sys.exit(f"error: {name} contains {bad!r} — inline it as base64 instead")


def main():
    if not SRC.exists():
        sys.exit(f"error: {SRC} not found")

    src = SRC.read_text(encoding="utf-8")
    code = {}
    for name, path in LIBS.items():
        if not path.exists():
            sys.exit(f"error: {path} not found — run fetch_libs.sh first")
        text = path.read_text(encoding="utf-8")
        check_inlinable(path.name, text)
        code[name] = text

    # 1. drop the two CDN <script src> tags
    out, n = re.subn(
        r'<script src="https://cdnjs\.cloudflare\.com/[^"]*"></script>\s*', "", src
    )
    if n != 2:
        sys.exit(f"error: expected 2 CDN script tags, removed {n} — has balloon.html changed?")

    # 2. CSP first, then the libraries, ahead of everything else
    inlined = (
        BANNER
        + f'<meta http-equiv="Content-Security-Policy" content="{CSP}">\n'
        + "<script>/* pdf.js 3.11.174 */\n" + code["pdf"] + "\n</script>\n"
        + "<script>/* pdf-lib 1.17.1 */\n" + code["pdflib"] + "\n</script>\n"
        + '<script id="pdfWorkerSrc" type="text/js-worker">\n' + code["pdfworker"] + "\n</script>\n"
    )
    out = inlined + out

    # 3. point the worker at a Blob built from the tag above, not at a fetch.
    #    balloon.html fetches the worker script from cdnjs at load time (so it
    #    still works when served over http(s), not just file://) and blobs it
    #    itself; offline has the script inlined already, so this collapses to
    #    a synchronous blob build with no network involved.
    old = (
        "// A Worker can't be constructed from a cross-origin script URL — browsers throw\n"
        "// a SecurityError, silently ever since (getDocument still resolves, but the\n"
        "// render never does). Only works via workerSrc-as-URL when this page's own\n"
        "// origin happens to be cdnjs, which it never is. So: fetch the worker script\n"
        "// ourselves and hand pdf.js a same-origin blob: URL instead. Opening the file\n"
        "// directly (file://) tolerates the direct URL, but anything served over\n"
        "// http(s) — an intranet copy, a share mapped to a web server — does not.\n"
        'const workerReadyPromise = (async () => {\n'
        '  try{\n'
        '    const resp = await fetch(\n'
        '      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js");\n'
        '    if(!resp.ok) throw new Error("HTTP "+resp.status);\n'
        '    const code = await resp.text();\n'
        '    pdfjsLib.GlobalWorkerOptions.workerSrc =\n'
        '      URL.createObjectURL(new Blob([code], {type:"application/javascript"}));\n'
        '  }catch(err){\n'
        '    console.error("Couldn\'t fetch the PDF.js worker script; falling back to the direct URL.", err);\n'
        '    pdfjsLib.GlobalWorkerOptions.workerSrc =\n'
        '      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";\n'
        '  }\n'
        '})();'
    )
    new = (
        "// The worker script is inlined above (see pdfWorkerSrc); no fetch needed.\n"
        "const workerReadyPromise = (() => {\n"
        '  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(\n'
        '    new Blob([document.getElementById("pdfWorkerSrc").textContent],\n'
        '             {type:"application/javascript"}));\n'
        "  return Promise.resolve();\n"
        "})();"
    )
    if old not in out:
        sys.exit("error: workerReadyPromise block not found — has balloon.html changed?")
    out = out.replace(old, new)

    # 4. the offline copy says so in the toolbar and on the empty state.
    #    Version-agnostic, and it shouts if it stops matching — a silent no-op
    #    here left the offline build indistinguishable from the CDN one.
    out, n = re.subn(
        r"(<span>rev&nbsp;\d+)(</span>)",
        "\\1 · offline\\2",
        out,
        count=1,
    )
    if n != 1:
        sys.exit("error: toolbar version tag not found — has the brand markup changed?")
    out = out.replace(
        "<em>PDF stays on this machine. Nothing is uploaded.</em>",
        "<em>Offline build — no network, no install. "
        "The PDF never leaves this machine.</em>",
    )

    OUT.write_text(out, encoding="utf-8")

    # 5. prove there's no origin left in the output
    leaks = sorted(set(re.findall(r"https?://[\w.-]+", out)))
    kb = len(out.encode("utf-8")) / 1024
    print(f"wrote {OUT.name}  {kb:,.0f} KB")
    if leaks:
        print("  remaining absolute URLs:")
        for u in leaks:
            print("   ", u)
    else:
        print("  no http(s) origin anywhere in the file")


if __name__ == "__main__":
    main()
