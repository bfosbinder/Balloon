# Balloon rev 3

Ballooning and inspection recording for PDF drawings. One HTML file, no install,
no server. Rev 2 adds unit IDs and splits the saved data into a reusable layout
and a per-unit record.

## Files

| File | What it is |
|---|---|
| `balloon.html` | The tool. Pulls PDF.js and pdf-lib from cdnjs, so it needs the network once per load. |
| `balloon-offline.html` | Same tool, libraries inlined, CSP that names no network origin. ~1.9 MB. Use this on the floor. |
| `build_offline.py` | Builds `balloon-offline.html` from `balloon.html`. Re-run after any edit. |
| `fetch_libs.sh` | Re-fetches the two libraries into `vendor/`. Only needed once. |
| `smoke.js` | 467 headless checks, including the job folder against an in-memory fake. `node smoke.js` |
| `verify_offline.js` | 24 checks that the offline build is the same tool, self-contained. `node verify_offline.js` |

Edit `balloon.html`, then:

```
python3 build_offline.py && node smoke.js && node verify_offline.js
```

## The job folder

Everything for one part lives in one folder on the share. The drawing is stored
once; nothing is a copy of anything else.

```
S:\Inspection\DEMO-1042\
  drawing\   master PDFs, written once, never rewritten
  layout\    v1.json, v2.json …  append-only, highest number is current
  records\   one small file per unit
  exports\   generated, disposable, safe to delete
```

Reached through the File System Access API, so **Chrome or Edge only**. Without
it the tool still works exactly as rev 2 did — the folder strip says so and the
Export menu is the whole story.

**Layouts are versioned files, not a mutated one.** Revising appends `v2.json`
and never touches `v1.json`, because a record stamped v1 needs v1's tolerances
to stay readable. Each layout records a SHA-256 of the drawing it was built
against; on open the app re-hashes and warns loudly if they differ. That's the
guard against someone dropping rev D over rev C and silently re-pointing every
historical record at the wrong print.

**Records are one file per inspection.** `1042-0007.json`, and a re-inspection
of the same unit becomes `1042-0007_r2.json` rather than overwriting. Unit IDs
are slugged for the filename, so `LOT 42/PC 7` is safe.

**Duplicate detection now reads the folder**, not just the current tab — so a
serial another inspector recorded last week on a different PC is caught before
anyone types a measurement.

### Working in it

The strip at the top of the side panel shows the folder, the current layout
version, and how many units are on file. Its one button changes with context:

- Layout on screen differs from what's published → **Publish layout v*n***
- Layout matches and results are entered → **Save results to folder**

Opening a folder that already has a layout loads it and its drawing
automatically and drops straight into Inspect mode. The operator never touches
the Export menu.

**Reopening is one click.** The folder is remembered between sessions, so the
strip offers **Reconnect to *folder*** on load rather than sending anyone back
through the share. Chrome still requires that click to re-grant access — that's
the security model and nothing gets around it — but within a session, or after
a soft reload, permission usually still stands and the job reattaches on its
own. If the folder has been moved or renamed, the offer is dropped and you're
told why.

Failures are survivable: a dead share, a read-only folder or a missing drawing
all leave the results on screen, keep the tab marked unsaved, and tell you to
export to a file instead.

## Two roles

The planner builds the layout and can change anything. The operator measures
parts and must not be able to change the spec by accident — their mistakes
become the quality record, so the app is deliberately narrower for them.

Set the role once per machine with a shortcut carrying `?role=operator`; it
sticks. `?role=planner` puts it back. It isn't a toggle in the UI, because a
toggle anyone can flip protects nothing.

In operator mode:

- The layout is **hard-locked** — not the soft lock that waits for the first
  result. No adding, dragging, deleting or renumbering, whatever the view.
- No Lay out toggle, no Open drawing, no Renumber, no Export menu.
- Work starts by **picking a part**, not by opening a file (see below).
- A **progress bar** answers the only question that matters mid-shift: how many
  measured, how many out, how many left.
- Failures go to a **banner that stays until dismissed**, not a toast. Someone
  with their eyes on a bore gage misses a four-second message and then believes
  the part was saved.

### The operator's save

- An out-of-tolerance reading **can't be saved without a note**. The banner
  names the characteristic, the list filters to the rejects, and the cursor
  lands in the right note field.
- An unfinished part **can** be saved — inspection gets interrupted — but it's
  confirmed first and stamped `INCOMPLETE` rather than left looking finished.
- A part with any reject asks for a **free-text disposition**, recorded on the
  record. Cancelling that prompt cancels the save.
- Records carry `status` (`ACCEPT` / `REJECT` / `INCOMPLETE`) and `disposition`.

## Picking a part

There's one **Open** button and it works out what you gave it, by looking
inside rather than by guessing from who's asking:

- Contains `layout/` or `records/` → it's a **part folder**; open it.
- Contains folders that do → it's the **inspection folder**; list the parts.
- Empty → it can't tell, so it **asks** rather than guessing.
- Unreadable → says so instead of silently adopting it.

Picking the inspection folder lists what's inside — folder name, layout
version, units on file, and whether it's been set up at all — with a search box
for when there are hundreds. One permission grant covers every part, for both
roles.

**Attaching to a folder never writes to it.** The subfolders are created by the
first thing that actually needs them: publishing makes `layout/`, saving a
record makes `records/`. So looking at the wrong folder leaves no trace.

## The data model

Rev 1 kept everything in one flat list. Rev 2 separates two things that have
different lifetimes:

- **Layout** — balloons, requirements, tolerances, methods. Belongs to a part
  number and revision. Made once, reused for every unit.
- **Record** — actuals, notes, who measured, when. Belongs to one unit ID.
  Made N times against one layout.

On screen they're merged into one list, because that's how you work. On disk
they're separate, because that's what lets thirty units share one layout.

### File shape

```jsonc
{
  "v": 2,
  "kind": "balloon-inspection",
  "meta": { "app": "Balloon rev 2", "written": "2026-08-01T14:02:00.000Z" },

  "layout": {
    "version": 1,                  // bumps every time you revise a locked layout
    "source": "DEMO-1042.pdf",
    "pages": 2,
    "part": { "partNo": "DEMO-1042", "partName": "MANIFOLD BODY",
              "rev": "C", "dwgNo": "DEMO-1042" },
    "unitLabel": "Serial No.",     // or Lot + Piece, Traveler No., Unit ID
    "unitPattern": "\\d{4}-\\d{4}", // optional; warns, never blocks
    "next": 12,
    "chars": [
      { "id": "b17293…", "num": 1, "page": 1,
        "ax": 412.5, "ay": 301.0, "bx": 455.1, "by": 258.4,
        "req": "4.500 ±.005", "nom": "4.5", "up": ".005", "lo": "-.005",
        "method": "CMM" }
    ]
  },

  "record": {                      // null in a layout-only file
    "unitId": "1042-0007",
    "seq": 1,                      // 2 = second time this ID was inspected
    "rework": false,
    "order": "4500123",
    "inspector": "B. Fosbinder",
    "date": "2026-08-01",
    "layoutVersion": 1,            // which layout version this was measured against
    "started": "2026-08-01T13:40:11.000Z",
    "completed": "2026-08-01T14:02:00.000Z",
    "results": {
      "b17293…": { "actual": "4.4988", "note": "" }
    }
  }
}
```

Results are keyed by characteristic `id`, not by balloon number, so renumbering
never orphans a measurement.

Rev 1 files load and upgrade automatically. The old `header.order`,
`header.inspector` and `header.date` move into the record; the rest becomes the
layout; the unit ID is left blank for you to fill in.

## The side panel

The title block folds. Open, it's the eight fields you fill in when setting a
job up; folded, it's a two-line summary — part number and rev, part name, then
inspector, date and order. Clicking the heading toggles it, and it folds itself
automatically when a layout arrives with a part number already on it, which is
the operator's case. That hands roughly 200px back to the characteristics list.

## Layout locking

The moment any actual or note is entered, the layout goes read-only —
requirements, tolerances, balloon positions, renumbering and deletion are all
frozen. The banner says so, and **Revise layout** unfreezes it and bumps
`layout.version`.

Records keep the version they were measured against. So if you revise after
inspecting five parts, those five stay stamped `layoutVersion: 1` while the
layout moves to 2, and the mismatch is visible in the file and the CSV.

## Unit IDs

The label is configurable per part because not everything is serialized —
`Serial No.`, `Lot + Piece`, `Traveler No.`, `Unit ID`.

- **ID format** (title block) takes a regular expression, anchored end to end.
  Mismatches warn and save anyway; a malformed pattern is ignored.
- Re-using an ID within a session bumps the inspection number and flags
  re-inspection, rather than blocking it — rework is legitimate.
- **Next unit** clears the results, keeps the layout, carries the inspector
  over, and files the closed-out unit into the session log.

## Saving

**Nothing saves automatically.** A page can't write to the file it was opened
from. Everything lives in the tab's memory until you pick something from the
Export menu, which builds the file in memory and hands it to the browser as a
download.

So the tool makes the gap visible instead:

- A **save indicator** sits next to the Export button. Amber `unsaved` means
  there's work in the tab that isn't on disk; green `saved 14:32` means the
  last full save covers everything on screen. Hover it for detail.
- **Closing or reloading the tab** with unsaved work triggers the browser's
  "Leave site?" prompt. It won't survive a crash or a power cut, but it catches
  the stray Ctrl+W, which is the common case.
- **Next unit** tells you whether the results it's about to clear are on disk
  before you confirm.

Only **Save inspection (.json)** clears the indicator, because only that file
can restore the screen. **Save layout only** clears it too when no results have
been entered yet. CSV and the ballooned PDF deliberately don't — they capture
the record, not the working state, so you couldn't resume from them.

The indicator compares a signature of the current state rather than setting a
flag, so typing a value and deleting it again goes back to clean instead of
nagging for the rest of the shift.

### The crash cache

Work in progress is copied into IndexedDB — local to that machine — a few
hundred milliseconds after each change, and deleted the moment the real record
lands in the job folder. If Chrome dies, the PC loses power, or the share drops
mid-shift, reopening the same part offers the work back:

> Unsaved work from 14:32 — SN-7, 23 readings. It never reached the folder.
> **[Restore it]**

It is offered, never applied on its own: a draft is by definition work whose
status nobody has confirmed. Dismissing the banner discards it. If the layout
has been revised since, the offer says so, and any reading whose characteristic
no longer exists is reported rather than silently dropped.

One draft per part folder, so working two parts in turn doesn't mix them up.
None of it is load-bearing — private browsing, a blocked database or a full
quota all fail quietly and leave the work on screen untouched.

The working rule is still: **save each unit before starting the next.** The
cache is a safety net, not the record.

## Exports

| Export | Contents |
|---|---|
| Inspection list (.csv) | Header block with part, unit, inspector, layout version; then one row per characteristic. |
| Ballooned drawing (.pdf) | Balloons burnt in, plus a one-line stamp in the bottom margin naming part, unit, inspector and date. |
| Save inspection (.json) | Layout + this unit's record. |
| Save layout only (.json) | Layout with `record: null`. This is the reusable template. |
| Session log (.csv) | One row per unit inspected since the page was opened, with counts and accept/reject. |

Filenames are `PARTNO_REVA_UNITID_YYYYMMDD_*`.

## Offline

`balloon-offline.html` inlines PDF.js 3.11.174 and pdf-lib 1.17.1, builds the
PDF.js worker from a Blob URL, and runs PDF.js with `isEvalSupported: false`
so no `unsafe-eval` is needed. Its Content-Security-Policy is:

```
default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:;
style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
connect-src blob: data:; base-uri 'none'; form-action 'none'
```

No `http:` or `https:` origin appears in it, so the browser refuses any outbound
request and logs a violation to the console if one is ever attempted.

To demonstrate this: disconnect the network, hard-reload, and run a full
workflow. Or open DevTools → Network, tick Preserve log and Disable cache,
reload, and confirm the only entry is the document itself.

The remaining `http://` strings inside the file are XML namespace identifiers
(`w3.org/2000/svg`, the Adobe XFA schemas) and a producer string pdf-lib writes
into PDF metadata. None are fetched. `verify_offline.js` checks that nothing
appears in a `src`, `href` or `url()`.

This proves the tool *doesn't* connect, not that it *can't* — a genuine "can't"
is a host firewall rule or an air-gapped machine, which is IT's control, not
the file's. Hash the file (`sha256sum`) so the version reviewed is provably the
version in use.

## Known gaps

- No autosave yet. A crash still loses whatever hasn't been written to the
  folder. IndexedDB crash-caching is phase 2.
- No review list, no Excel aggregation, no PDF-on-demand yet — phases 3 to 5.
- File System Access is Chromium-only. On Firefox the folder features simply
  don't appear and the file-based flow is the whole tool.
- Two people can't work the same job at once. That needs a server.
- GD&T frames drawn as vector geometry carry no text layer, so click-to-read
  finds nothing on them.
- The requirement parser misreads the `X` in chamfer callouts like `.060 X 45°`.
- Duplicate-ID detection needs a job folder; without one it sees only the current session.
