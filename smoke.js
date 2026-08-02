/* Headless checks for balloon.html rev 2.
   Loads the page in jsdom with the PDF libraries stubbed, then drives the
   real functions the way the UI does. Run: node smoke.js            */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; }
  else { fail++; console.log("  FAIL  " + name + (extra ? "  → " + extra : "")); }
};
const eq = (name, got, want) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const html = fs.readFileSync(path.join(__dirname, "balloon.html"), "utf8");

// swap the two CDN tags for a local stub so the page's own script runs for real
const STUB = `<script>
  window.pdfjsLib = { GlobalWorkerOptions:{}, Util:{ transform:(a,b)=>b } };
  window.PDFLib = {};
<\/script>`;
const testHtml = html
  .replace(/<script src="https:\/\/cdnjs[^"]*"><\/script>\s*/g, "")
  .replace("<style>", STUB + "\n<style>");

// jsdom has no IndexedDB; Handles needs one. A brand-new factory per boot, so
// a folder remembered in one test can't leak into the next.
const { IDBFactory, IDBKeyRange } = require("fake-indexeddb");
const freshIDB = () => ({ indexedDB: new IDBFactory(), IDBKeyRange });

function boot() {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole: new (require("jsdom").VirtualConsole)()   // swallow jsdom noise
  });
  const w = dom.window;
  const idb = freshIDB();
  w.indexedDB = idb.indexedDB;
  w.IDBKeyRange = idb.IDBKeyRange;
  w.document.open();
  w.document.write(testHtml);
  w.document.close();

  // jsdom has no SVG geometry; stub what drawBalloons/svgPt touch
  const svg = w.document.getElementById("ov");
  svg.createSVGPoint = () => ({ x: 0, y: 0, matrixTransform: () => ({ x: 0, y: 0 }) });
  svg.getScreenCTM = () => ({ inverse: () => ({}) });
  Object.defineProperty(svg, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, width: 100, height: 100 }) });

  // capture downloads instead of writing files
  const saved = [];
  w.URL.createObjectURL = () => "blob:x";
  w.URL.revokeObjectURL = () => {};
  const realCreate = w.document.createElement.bind(w.document);
  w.document.createElement = tag => {
    const el = realCreate(tag);
    if (tag === "a") el.click = function () { saved.push({ name: this.download }); };
    return el;
  };
  w.confirm = () => true;
  // jsdom ships getRandomValues but not subtle; sha256() needs the real thing
  if (!w.crypto.subtle) {
    Object.defineProperty(w.crypto, "subtle",
      { value: require("crypto").webcrypto.subtle, configurable: true });
  }

  // S, Store and Handles are top-level `const`s — lexical globals, not window
  // properties. Indirect eval runs in global scope and can see them.
  const g = w.eval("({S:S, Store:Store, Handles:Handles, Cache:Cache, Prefs:Prefs})");
  w.S = g.S; w.Store = g.Store; w.Handles = g.Handles; w.Cache = g.Cache; w.Prefs = g.Prefs;

  return { w, saved, $: id => w.document.getElementById(id) };
}

// helper: add a characteristic straight into state (place() needs a live PDF)
function addChar(w, over) {
  const b = Object.assign({
    id: "b" + (w.S.layout.next), num: w.S.layout.next++, page: 1,
    ax: 10, ay: 10, bx: 30, by: 30,
    req: "1.250 ±.005", nom: "1.25", up: ".005", lo: "-.005",
    actual: "", method: "", note: ""
  }, over || {});
  w.S.balloons.push(b);
  return b;
}

async function main(){
console.log("\nballoon.html rev 3 — headless checks\n");

/* ============================ 1. carried-over behaviour ============================ */
{
  const { w } = boot();
  const p = w.parseReq;
  eq("parse ± bilateral",        p("1.250 ±.005"), { nom: 1.25, up: 0.005, lo: -0.005 });
  eq("parse stacked +/-",        p("⌀1.2500 +.0015 −.0000"), { nom: 1.25, up: 0.0015, lo: -0 });
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const lim = p("1.125/1.135");   // raw floats carry noise; fmt() rounds it off downstream
  ok("parse limits pair", near(lim.nom, 1.13) && near(lim.up, 0.005) && near(lim.lo, -0.005),
     JSON.stringify(lim));
  eq("parse limits pair formats clean", [w.fmt(lim.up), w.fmt(lim.lo)], ["0.005", "-0.005"]);
  eq("parse basic in brackets",  p("[3.500]"), { nom: 3.5 });
  eq("parse reference in parens", p("(2.000)"), {});
  eq("parse drops 4X prefix",    p("4X ⌀.281 THRU"), { nom: 0.281 });

  const v = w.verdict;
  ok("verdict accepts in-band",  v({ actual: "1.252", nom: "1.25", up: ".005", lo: "-.005" }) === true);
  ok("verdict rejects out",      v({ actual: "1.260", nom: "1.25", up: ".005", lo: "-.005" }) === false);
  ok("verdict null when open",   v({ actual: "", nom: "1.25", up: ".005", lo: "-.005" }) === null);
  ok("verdict accepts on limit", v({ actual: "1.255", nom: "1.25", up: ".005", lo: "-.005" }) === true);
}

/* ============================ 2. layout / record split ============================ */
{
  const { w } = boot();
  addChar(w, { actual: "1.2512", note: "mic" });
  addChar(w);
  w.S.layout.part.partNo = "DEMO-1042";
  w.S.layout.part.rev = "C";
  w.S.record.unitId = "1042-0007";
  w.S.record.inspector = "B. Fosbinder";
  w.S.record.date = "2026-08-01";

  const f = w.fileObject(true);
  eq("file version", f.v, 2);
  ok("layout holds chars", f.layout.chars.length === 2);
  ok("layout char has no actual", !("actual" in f.layout.chars[0]));
  ok("layout char has no note", !("note" in f.layout.chars[0]));
  ok("layout carries part identity", f.layout.part.partNo === "DEMO-1042" && f.layout.part.rev === "C");
  ok("record carries unit id", f.record.unitId === "1042-0007");
  ok("record holds only measured results", Object.keys(f.record.results).length === 1);
  eq("result keyed by char id", f.record.results[f.layout.chars[0].id], { actual: "1.2512", note: "mic" });
  ok("record stamps layout version", f.record.layoutVersion === 1);

  const g = w.fileObject(false);
  ok("layout-only export drops the record", g.record === null);
  ok("layout-only export keeps chars", g.layout.chars.length === 2);
}

/* ============================ 3. round trip ============================ */
{
  const { w } = boot();
  addChar(w, { actual: "1.2512", note: "mic" });
  addChar(w, { actual: "0.501" });
  w.S.layout.part.partNo = "DEMO-1042";
  w.S.layout.unitLabel = "Traveler No.";
  w.S.layout.unitPattern = "\\d{4}-\\d{4}";
  w.S.record.unitId = "1042-0007";
  w.S.record.seq = 2;
  w.S.record.rework = true;

  const before = JSON.parse(JSON.stringify(w.S.balloons));
  const f = JSON.parse(JSON.stringify(w.fileObject(true)));
  w.adopt(f);

  eq("round trip keeps every char", w.S.balloons.length, before.length);
  eq("round trip keeps actuals", w.S.balloons.map(b => b.actual), ["1.2512", "0.501"]);
  eq("round trip keeps notes", w.S.balloons.map(b => b.note), ["mic", ""]);
  eq("round trip keeps unit id", w.S.record.unitId, "1042-0007");
  eq("round trip keeps seq", w.S.record.seq, 2);
  eq("round trip keeps rework", w.S.record.rework, true);
  eq("round trip keeps unit label", w.S.layout.unitLabel, "Traveler No.");
  eq("round trip keeps id pattern", w.S.layout.unitPattern, "\\d{4}-\\d{4}");
  eq("round trip keeps part no", w.S.layout.part.partNo, "DEMO-1042");
}

/* ============================ 4. layout template reuse ============================ */
{
  const { w } = boot();
  addChar(w, { actual: "1.2512" });
  addChar(w, { actual: "0.501" });
  w.S.layout.part.partNo = "DEMO-1042";
  const template = JSON.parse(JSON.stringify(w.fileObject(false)));

  w.adopt(template);
  eq("template restores the layout", w.S.balloons.length, 2);
  eq("template carries no actuals", w.S.balloons.map(b => b.actual), ["", ""]);
  eq("template carries no unit id", w.S.record.unitId, "");
  ok("template leaves layout unlocked", w.locked() === false);
  ok("template keeps requirements", w.S.balloons.every(b => b.req === "1.250 ±.005"));
}

/* ============================ 5. locking ============================ */
{
  const { w, $ } = boot();
  const a = addChar(w);
  addChar(w);
  ok("unlocked with no results", w.locked() === false);

  a.actual = "1.2512";
  ok("locked once a result exists", w.locked() === true);

  const n = w.S.balloons.length;
  w.remove(a.id);
  eq("remove refused while locked", w.S.balloons.length, n);

  w.S.balloons[0].num = 1;
  $("renum").onclick();
  ok("renumber refused while locked", w.S.layout.next === n + 1);

  const wasVersion = w.S.layout.version;
  $("revise").onclick();
  ok("revise bumps the layout version", w.S.layout.version === wasVersion + 1);
  ok("revise unlocks", w.locked() === false);
  w.remove(w.S.balloons[1].id);
  eq("remove allowed after revising", w.S.balloons.length, n - 1);

  // a note alone also counts as a result
  const { w: w2 } = boot();
  const c = addChar(w2);
  c.note = "chased thread";
  ok("a note alone locks the layout", w2.locked() === true);
}

/* ============================ 6. lock banner + read-only rows ============================ */
{
  const { w, $ } = boot();
  const a = addChar(w);
  w.paintList();
  ok("no lock banner when unlocked", $("lockbar").hidden === true);
  ok("requirement editable when unlocked", !$("list").querySelector(".req").hasAttribute("readonly"));

  a.actual = "1.2512";
  w.paintList();
  ok("lock banner shows when locked", $("lockbar").hidden === false);
  ok("banner names the layout version", /layout v1/.test($("lockmsg").textContent));
  ok("requirement read-only when locked", $("list").querySelector(".req").hasAttribute("readonly"));
  ok("nominal read-only when locked", $("list").querySelector('[data-k="nom"]').hasAttribute("readonly"));
  ok("actual still editable when locked", !$("list").querySelector('[data-k="actual"]').hasAttribute("readonly"));
  ok("delete disabled when locked", $("list").querySelector(".kill").disabled === true);
  ok("version readout tracks layout", $("layVer").textContent === "layout v1");
}

/* ============================ 7. next unit ============================ */
{
  const { w, $ } = boot();
  addChar(w, { actual: "1.2512", note: "mic" });
  addChar(w, { actual: "1.2489" });
  w.S.record.unitId = "1042-0007";
  w.S.record.inspector = "B. Fosbinder";
  $("h_insp").value = "B. Fosbinder";

  $("u_new").onclick();
  eq("next unit clears actuals", w.S.balloons.map(b => b.actual), ["", ""]);
  eq("next unit clears notes", w.S.balloons.map(b => b.note), ["", ""]);
  eq("next unit keeps the layout", w.S.balloons.length, 2);
  eq("next unit keeps requirements", w.S.balloons[0].req, "1.250 ±.005");
  eq("next unit clears the id", w.S.record.unitId, "");
  eq("next unit carries the inspector over", w.S.record.inspector, "B. Fosbinder");
  eq("closed-out unit lands in the log", w.S.log.length, 1);
  eq("log keeps the old id", w.S.log[0].unitId, "1042-0007");
  eq("log counts measured", w.S.log[0].done, 2);
  eq("log verdict", w.S.log[0].result, "ACCEPT");
  ok("next unit unlocks the layout", w.locked() === false);
}

/* ============================ 8. duplicate unit id ============================ */
{
  const { w, $ } = boot();
  addChar(w, { actual: "1.2512" });
  w.S.record.unitId = "1042-0007";
  $("u_new").onclick();

  $("u_id").value = "1042-0007";
  $("u_id").oninput({ target: $("u_id") });
  await $("u_id").onchange();
  eq("repeat id bumps the inspection number", w.S.record.seq, 2);
  ok("repeat id flags re-inspection", w.S.record.rework === true);
  ok("repeat id warns", $("u_warn").hidden === false && /has been inspected/.test($("u_warn").textContent));
  ok("session wording when there's no folder", /this session/.test($("u_warn").textContent));

  // case-insensitive
  const { w: w2, $: $2 } = boot();
  addChar(w2, { actual: "1.0" });
  w2.S.record.unitId = "AB-12";
  $2("u_new").onclick();
  $2("u_id").value = "ab-12";
  $2("u_id").oninput({ target: $2("u_id") });
  await $2("u_id").onchange();
  eq("duplicate check ignores case", w2.S.record.seq, 2);
}

/* ============================ 9. id format check ============================ */
{
  const { w, $ } = boot();
  w.S.layout.unitPattern = "\\d{4}-\\d{4}";
  w.S.record.unitId = "1042-0007";
  w.checkUnit(false);
  ok("matching id passes quietly", $("u_warn").hidden === true);

  w.S.record.unitId = "oops";
  w.checkUnit(false);
  ok("mismatched id warns", $("u_warn").hidden === false && /format/.test($("u_warn").textContent));

  w.S.layout.unitPattern = "[unclosed";
  w.S.record.unitId = "anything";
  w.checkUnit(false);
  ok("a broken pattern doesn't throw", $("u_warn").hidden === true);

  w.S.layout.unitPattern = "\\d+";
  w.S.record.unitId = "12345";
  w.checkUnit(false);
  ok("pattern is anchored end to end", $("u_warn").hidden === true);
  w.S.record.unitId = "12345X";
  w.checkUnit(false);
  ok("trailing junk fails the pattern", $("u_warn").hidden === false);
}

/* ============================ 10. v1 migration ============================ */
{
  const { w } = boot();
  const v1 = {
    v: 1, source: "DEMO-1042_manifold_body.pdf", pages: 2, next: 3,
    header: { partNo: "DEMO-1042", partName: "MANIFOLD BODY", rev: "C", dwgNo: "DEMO-1042",
              order: "4500123", inspector: "B. Fosbinder", date: "2026-07-30" },
    balloons: [
      { id: "bA", num: 1, page: 1, ax: 1, ay: 2, bx: 3, by: 4, req: "4.500 ±.005",
        nom: "4.5", up: ".005", lo: "-.005", actual: "4.4988", method: "CMM", note: "" },
      { id: "bB", num: 2, page: 2, ax: 5, ay: 6, bx: 7, by: 8, req: ".062 ±.003",
        nom: ".062", up: ".003", lo: "-.003", actual: "", method: "", note: "" }
    ]
  };
  const j = w.migrate(v1);
  eq("migrated to v2", j.v, 2);
  eq("migration flagged", j.meta.migratedFrom, 1);
  eq("migration keeps chars", j.layout.chars.length, 2);
  eq("migration lifts part identity", j.layout.part.partNo, "DEMO-1042");
  eq("migration keeps next", j.layout.next, 3);
  eq("migration moves order to the record", j.record.order, "4500123");
  eq("migration keeps only measured results", Object.keys(j.record.results), ["bA"]);
  eq("migration keeps the actual", j.record.results.bA.actual, "4.4988");
  eq("migration leaves the unit id blank", j.record.unitId, "");
  ok("migrated char keeps geometry", j.layout.chars[0].ax === 1 && j.layout.chars[0].by === 8 - 4);

  w.adopt(j);
  eq("migrated file adopts cleanly", w.S.balloons.length, 2);
  eq("migrated actual survives adopt", w.S.balloons[0].actual, "4.4988");
  eq("migrated method survives adopt", w.S.balloons[0].method, "CMM");
  ok("migrated file locks (it has a result)", w.locked() === true);

  // v2 passes through untouched
  const two = w.fileObject(true);
  ok("v2 passes through migrate", w.migrate(two) === two);

  // junk is rejected
  let threw = false;
  try { w.migrate({ hello: "world" }); } catch (e) { threw = true; }
  ok("junk file rejected", threw);
}

/* ============================ 11. filenames ============================ */
{
  const { w } = boot();
  w.S.name = "DEMO-1042_manifold_body.pdf";
  w.S.layout.part.partNo = "DEMO-1042";
  w.S.layout.part.rev = "C";
  w.S.record.unitId = "1042-0007";
  w.S.record.date = "2026-08-01";
  eq("stem carries part, rev, unit, date", w.stem(), "DEMO-1042_REVC_1042-0007_20260801");

  w.S.record.unitId = "";
  eq("stem without a unit id", w.stem(), "DEMO-1042_REVC_20260801");

  w.S.layout.part.partNo = "";
  w.S.layout.part.rev = "";
  eq("stem falls back to the pdf name", w.stem(), "DEMO-1042_manifold_body_20260801");

  w.S.layout.part.partNo = "PN 1234/A B";
  w.S.record.unitId = "SN 7";
  eq("stem scrubs separators", w.stem(), "PN_1234_A_B_SN_7_20260801");
}

/* ============================ 12. exports ============================ */
{
  const { w, saved, $ } = boot();
  addChar(w, { actual: "1.2512", method: "Micrometer" });
  addChar(w, { actual: "1.2600" });      // out of tolerance
  addChar(w);                             // open
  w.S.layout.part.partNo = "DEMO-1042";
  w.S.layout.part.rev = "C";
  w.S.record.unitId = "1042-0007";
  w.S.record.date = "2026-08-01";
  w.S.record.inspector = "B. Fosbinder";

  $("eCsv").onclick();
  eq("csv filename", saved.pop().name, "DEMO-1042_REVC_1042-0007_20260801_inspection.csv");

  $("eJson").onclick();
  eq("inspection json filename", saved.pop().name, "DEMO-1042_REVC_1042-0007_20260801_inspection.json");

  $("eLayout").onclick();
  eq("layout json filename", saved.pop().name, "DEMO-1042_REVC_layout.json");

  $("eLog").onclick();
  ok("session log filename", /^DEMO-1042_session_\d{8}\.csv$/.test(saved.pop().name));

  const line = w.unitLine();
  ok("pdf stamp names the part", /DEMO-1042 REV C/.test(line));
  ok("pdf stamp names the unit", /SERIAL NO\. 1042-0007/.test(line));
  ok("pdf stamp names the inspector", /B\. Fosbinder/.test(line));
  ok("pdf stamp carries the date", /2026-08-01/.test(line));

  w.S.record.rework = true;
  w.S.record.seq = 2;
  ok("pdf stamp flags re-inspection", /RE-INSPECTION/.test(w.unitLine()));
  ok("pdf stamp shows inspection number", /#2/.test(w.unitLine()));
}

/* ============================ 13. session log content ============================ */
{
  const { w, $ } = boot();
  addChar(w, { actual: "1.2512" });
  addChar(w, { actual: "1.2600" });   // reject
  w.S.record.unitId = "SN-1";
  $("u_new").onclick();
  eq("rejected unit logged as REJECT", w.S.log[0].result, "REJECT");
  eq("reject counted", w.S.log[0].bad, 1);

  w.S.record.unitId = "SN-2";
  w.S.balloons[0].actual = "1.2500";
  $("u_new").onclick();
  eq("partial unit logged as INCOMPLETE", w.S.log[1].result, "INCOMPLETE");
  eq("two units in the log", w.S.log.length, 2);
  eq("log preserves order", w.S.log.map(e => e.unitId), ["SN-1", "SN-2"]);
}

/* ============================ 14. record version stamping ============================ */
{
  const { w, $ } = boot();
  const a = addChar(w);
  w.paintList();
  ok("no layout version until a result lands", w.S.record.layoutVersion === null);

  const el = $("list").querySelector('[data-k="actual"]');
  el.value = "1.2512";
  el.dispatchEvent(new w.Event("input"));
  eq("first result stamps the layout version", w.S.record.layoutVersion, 1);
  eq("actual reached state", w.S.balloons[0].actual, "1.2512");
  ok("started timestamp set", typeof w.S.record.started === "string");

  $("revise").onclick();
  eq("record keeps the version it was taken against", w.S.record.layoutVersion, 1);
  eq("layout has moved on", w.S.layout.version, 2);

  const f = w.fileObject(true);
  eq("saved record keeps its own version", f.record.layoutVersion, 1);
  eq("saved layout keeps the new version", f.layout.version, 2);
}

/* ============================ 15. locking mid-keystroke ============================ */
{
  const { w, $ } = boot();
  addChar(w); addChar(w);
  w.paintList();

  const row = $("list").querySelector(".row");
  const actual = row.querySelector('[data-k="actual"]');
  const req = row.querySelector(".req");
  actual.focus();
  ok("focus starts in the actual field", w.document.activeElement === actual);

  actual.value = "1.2512";
  actual.dispatchEvent(new w.Event("input"));

  ok("layout locked by the keystroke", w.locked() === true);
  ok("row was not rebuilt", $("list").querySelector(".row") === row);
  ok("focus survived the lock", w.document.activeElement === actual);
  ok("requirement went read-only in place", req.readOnly === true);
  ok("nominal went read-only in place", row.querySelector('[data-k="nom"]').readOnly === true);
  ok("method disabled in place", row.querySelector('[data-k="method"]').disabled === true);
  ok("delete disabled in place", row.querySelector(".kill").disabled === true);
  ok("actual stayed editable", actual.readOnly === false);
  ok("lock banner appeared", $("lockbar").hidden === false);

  // clearing the only result unlocks again
  actual.value = "";
  actual.dispatchEvent(new w.Event("input"));
  ok("cleared result unlocks", w.locked() === false);
  ok("requirement editable again", req.readOnly === false);
  ok("delete enabled again", row.querySelector(".kill").disabled === false);
  ok("lock banner hidden again", $("lockbar").hidden === true);
}

/* ============================ 17. save state ============================ */
{
  const { w, $ } = boot();
  ok("indicator hidden on an empty sheet", $("savestate").hidden === true);
  ok("empty sheet is not dirty", w.dirty() === false);

  addChar(w);
  w.paintList();
  ok("indicator shows once there's a layout", $("savestate").hidden === false);
  ok("a new balloon is dirty", w.dirty() === true);
  ok("indicator reads unsaved", $("savetext").textContent === "unsaved");
  ok("indicator styled unsaved", $("savestate").classList.contains("unsaved"));

  $("eJson").onclick();
  ok("saving the inspection clears dirty", w.dirty() === false);
  ok("indicator reads saved with a time", /^saved \d\d:\d\d$/.test($("savetext").textContent));
  ok("indicator styled clean", $("savestate").classList.contains("clean"));

  // a measurement dirties it again
  const el = $("list").querySelector('[data-k="actual"]');
  el.value = "1.2512";
  el.dispatchEvent(new w.Event("input"));
  ok("a result dirties without repainting the list", w.dirty() === true);
  ok("indicator updated on the keystroke", $("savetext").textContent === "unsaved");

  // undoing the change goes back to clean rather than nagging
  el.value = "";
  el.dispatchEvent(new w.Event("input"));
  ok("undo returns to clean", w.dirty() === false);

  // header edits count
  $("h_partNo").value = "DEMO-1042";
  $("h_partNo").dispatchEvent(new w.Event("input"));
  ok("a title block edit dirties", w.dirty() === true);
  $("eJson").onclick();
  ok("clean again after saving", w.dirty() === false);

  // unit id counts
  $("u_id").value = "1042-0007";
  $("u_id").oninput({ target: $("u_id") });
  ok("a unit id dirties", w.dirty() === true);

  // csv and pdf don't claim to have saved everything
  $("eCsv").onclick();
  ok("csv export does not clear dirty", w.dirty() === true);
}

/* ============================ 18. layout-only save ============================ */
{
  const { w, $ } = boot();
  addChar(w); addChar(w);
  w.paintList();
  $("eLayout").onclick();
  ok("layout-only save is enough when there are no results", w.dirty() === false);

  const el = $("list").querySelector('[data-k="actual"]');
  el.value = "1.2512";
  el.dispatchEvent(new w.Event("input"));
  $("eLayout").onclick();
  ok("layout-only save is not enough once results exist", w.dirty() === true);
  $("eJson").onclick();
  ok("full save covers it", w.dirty() === false);
}

/* ============================ 19. loaded files start clean ============================ */
{
  const { w, $ } = boot();
  addChar(w, { actual: "1.2512" });
  w.S.record.unitId = "1042-0007";
  const f = JSON.parse(JSON.stringify(w.fileObject(true)));

  const { w: w2 } = boot();
  w2.adopt(f);
  ok("a freshly loaded inspection is clean", w2.dirty() === false);
  ok("loaded file keeps its results", w2.S.balloons[0].actual === "1.2512");
}

/* ============================ 20. unload guard ============================ */
{
  const { w, $ } = boot();
  // jsdom ties Event.returnValue to the canceled flag, so assigning it here
  // would cancel the event before the page ever sees it. Just dispatch.
  const fire = () => {
    const e = new w.Event("beforeunload", { cancelable: true });
    w.dispatchEvent(e);
    return e.defaultPrevented;
  };
  ok("no prompt on an empty sheet", fire() === false);

  addChar(w, { actual: "1.2512" });
  w.paintList();
  ok("prompts with unsaved work", fire() === true);

  $("eJson").onclick();
  ok("no prompt once saved", fire() === false);

  const el = $("list").querySelector('[data-k="actual"]');
  el.value = "1.2600";
  el.dispatchEvent(new w.Event("input"));
  ok("prompts again after a change", fire() === true);
}

/* ============================ 22. fake job folder ============================ */
// An in-memory stand-in for FileSystemDirectoryHandle — enough of the shape
// that Store can't tell the difference.
function fakeDir(name) {
  const files = new Map(), dirs = new Map();
  const asFile = rec => ({
    async text() {
      if (typeof rec.data === "string") return rec.data;
      if (rec.data && rec.data.text) return rec.data.text();
      return Buffer.from(rec.data).toString("utf8");
    },
    async arrayBuffer() {
      if (typeof rec.data === "string") return Buffer.from(rec.data).buffer;
      if (rec.data && rec.data.arrayBuffer) return rec.data.arrayBuffer();
      return rec.data;
    }
  });
  return {
    kind: "directory", name,
    _perm: "granted",
    async queryPermission() { return this._perm; },
    async requestPermission() {
      if (this._perm === "prompt") this._perm = "granted";
      return this._perm;
    },
    async getDirectoryHandle(n, opt) {
      if (!dirs.has(n)) {
        if (!opt || !opt.create) throw new Error("NotFoundError: " + n);
        dirs.set(n, fakeDir(n));
      }
      return dirs.get(n);
    },
    async getFileHandle(n, opt) {
      if (!files.has(n)) {
        if (!opt || !opt.create) throw new Error("NotFoundError: " + n);
        files.set(n, { name: n, data: "" });
      }
      const rec = files.get(n);
      return {
        kind: "file", name: n,
        async getFile() { return asFile(rec); },
        async createWritable() {
          return { async write(d) { rec.data = d; }, async close() {} };
        }
      };
    },
    async *entries() {
      for (const [n] of files) yield [n, { kind: "file", name: n }];
      for (const [n, d] of dirs) yield [n, d];
    },
    _files: files, _dirs: dirs
  };
}

function useMemoryHandles(w) {
  let held = null;
  w.Handles.remember = async h => { held = h; };
  w.Handles.last = async () => held;
  w.Handles.forget = async () => { held = null; };
  return w.Handles;
}

// boot with the folder API "available" and a fake folder attached
async function bootWithFolder() {
  const ctx = boot();
  ctx.w.showDirectoryPicker = async () => ctx.dir;
  ctx.dir = fakeDir("DEMO-1042");
  useMemoryHandles(ctx.w);
  await ctx.w.attachJob(ctx.dir);
  return ctx;
}

{
  const { w, dir } = await bootWithFolder();
  ok("store reports attached", w.Store.attached === true);
  eq("store takes the folder name", w.Store.name, "DEMO-1042");

  // Looking at a folder must not leave anything in it. Creating the structure
  // on attach meant picking the wrong folder silently littered it.
  eq("attaching creates nothing", [...dir._dirs.keys()].sort(), []);

  // writing is what makes the folders, and only the ones it needs
  await w.Store.writeRecord({ unitId: "SN-1", seq: 1, results: {} });
  eq("saving a record makes records/", [...dir._dirs.keys()].sort(), ["records"]);
  await w.Store.publishLayout({ chars: [] });
  eq("publishing makes layout/", [...dir._dirs.keys()].sort(), ["layout", "records"]);

  await w.Store.attach(dir);   // attaching twice must not duplicate or throw
  eq("re-attach is harmless", [...dir._dirs.keys()].sort(), ["layout", "records"]);
}

/* ============================ 22b. what is this folder? ============================ */
{
  const { w } = boot();
  const withDirs = async (name, subs) => {
    const d = fakeDir(name);
    for (const s of subs) await d.getDirectoryHandle(s, { create: true });
    return d;
  };

  eq("a folder with records/ is a part", await w.Store.classify(await withDirs("5116", ["records"])), "part");
  eq("a folder with layout/ is a part", await w.Store.classify(await withDirs("5116", ["layout"])), "part");
  eq("an empty folder is ambiguous", await w.Store.classify(fakeDir("new")), "empty");

  const root = fakeDir("Inspection");
  const part = await root.getDirectoryHandle("DEMO-1042", { create: true });
  await part.getDirectoryHandle("records", { create: true });
  eq("a folder holding a part folder is a root", await w.Store.classify(root), "root");

  const dead = fakeDir("gone");
  dead.entries = () => ({ async next() { throw new Error("NotFoundError"); } });
  dead.getDirectoryHandle = async () => { throw new Error("NotFoundError"); };
  eq("an unreachable folder says so", await w.Store.classify(dead), "unreadable");
}

/* ============================ 22c. picking the wrong folder ============================ */
{
  // the exact mistake that prompted this: a planner picks the inspection folder
  const { w, $ } = boot();
  useMemoryHandles(w);
  const root = fakeDir("Inspection");
  for (const n of ["5116", "DEMO-1042"]) {
    const d = await root.getDirectoryHandle(n, { create: true });
    await d.getDirectoryHandle("layout", { create: true });
  }
  w.showDirectoryPicker = async () => root;
  await w.openJob();

  eq("nothing was created in it", [...root._dirs.keys()].sort(), ["5116", "DEMO-1042"]);
  ok("it wasn't adopted as a part", w.Store.attached === false);
  ok("it was recognised as the root", w.Store.hasRoot === true);
  ok("and the part picker opened", $("parts").hidden === false);
  ok("the strip names the inspection folder", $("jobName").textContent === "Inspection");
  ok("and says how many parts", /2 parts/.test($("jobStat").textContent));
  ok("no stale 'not connected'", !/not connected/.test($("jobName").textContent));

  // an empty folder asks rather than guessing
  const blank = fakeDir("NEW-PART");
  const b2 = boot(); useMemoryHandles(b2.w);
  b2.w.showDirectoryPicker = async () => blank;
  b2.w.confirm = () => true;                 // "yes, it's a single part"
  await b2.w.openJob();
  ok("confirmed as a part folder", b2.w.Store.attached === true);

  const blank2 = fakeDir("Inspection2");
  const b3 = boot(); useMemoryHandles(b3.w);
  b3.w.showDirectoryPicker = async () => blank2;
  b3.w.confirm = () => false;                // "no, it holds part folders"
  await b3.w.openJob();
  ok("declined becomes a root", b3.w.Store.hasRoot === true);
  ok("and isn't attached as a part", b3.w.Store.attached === false);
  eq("still nothing written into it", [...blank2._dirs.keys()].length, 0);
}

/* ============================ 23. layout versioning on disk ============================ */
{
  const { w, dir } = await bootWithFolder();
  ok("empty folder has no layout", (await w.Store.readLayout()) === null);

  const v1 = await w.Store.publishLayout({ part: { partNo: "DEMO-1042" }, chars: [{ id: "a" }] });
  eq("first publish is v1", v1, 1);
  const v2 = await w.Store.publishLayout({ part: { partNo: "DEMO-1042" }, chars: [{ id: "a" }, { id: "b" }] });
  eq("second publish is v2", v2, 2);

  const files = [...dir._dirs.get("layout")._files.keys()].sort();
  eq("both versions on disk", files, ["v1.json", "v2.json"]);

  const latest = await w.Store.readLayout();
  eq("readLayout returns the newest", latest.version, 2);
  eq("newest has both chars", latest.chars.length, 2);

  const old = await w.Store.readLayout(1);
  eq("an old version is still readable", old.version, 1);
  eq("v1 untouched by the v2 publish", old.chars.length, 1);
  ok("publish stamps a timestamp", typeof latest.published === "string");

  // ten versions sort numerically, not lexically
  for (let i = 3; i <= 11; i++) await w.Store.publishLayout({ chars: [] });
  eq("v11 beats v9 in the ordering", (await w.Store.readLayout()).version, 11);
}

/* ============================ 24. record files ============================ */
{
  const { w, dir } = await bootWithFolder();
  eq("record name is slugged", w.recordName("1042-0007", 1), "1042-0007.json");
  eq("re-inspection gets its own file", w.recordName("1042-0007", 2), "1042-0007_r2.json");
  eq("awkward ids are made safe", w.recordName("LOT 42/PC 7", 1), "LOT_42_PC_7.json");
  eq("an empty id still yields a name", w.recordName("", 1), "unit.json");

  await w.Store.writeRecord({ unitId: "1042-0007", seq: 1, results: { a: { actual: "1.25" } }, date: "2026-08-01" });
  await w.Store.writeRecord({ unitId: "1042-0007", seq: 2, rework: true, results: {}, date: "2026-08-02" });
  await w.Store.writeRecord({ unitId: "1042-0008", seq: 1, results: {}, date: "2026-08-01" });

  const files = [...dir._dirs.get("records")._files.keys()].sort();
  eq("one file per inspection", files, ["1042-0007.json", "1042-0007_r2.json", "1042-0008.json"]);

  const recs = await w.Store.listRecords();
  eq("all records listed", recs.length, 3);
  eq("unit ids read back", recs.map(r => r.unitId).sort(), ["1042-0007", "1042-0007", "1042-0008"]);
  ok("rework flag survives", recs.find(r => r.seq === 2).rework === true);
  eq("results survive", recs.find(r => r.file === "1042-0007.json").results.a.actual, "1.25");

  // a stray file in the folder must not break the listing
  const rd = await dir.getDirectoryHandle("records");
  const h = await rd.getFileHandle("notes.json", { create: true });
  const wr = await h.createWritable(); await wr.write("this is not json"); await wr.close();
  eq("junk in the folder is skipped, not fatal", (await w.Store.listRecords()).length, 3);
}

/* ============================ 25. the master drawing ============================ */
{
  const { w, dir } = await bootWithFolder();
  await w.Store.putDrawing("DEMO-1042_REVC.pdf", "ORIGINAL");
  await w.Store.putDrawing("DEMO-1042_REVC.pdf", "REPLACEMENT");
  const got = await w.Store.readText("drawing", "DEMO-1042_REVC.pdf");
  eq("a master drawing is never overwritten", got, "ORIGINAL");

  await w.Store.putDrawing("DEMO-1042_REVD.pdf", "NEXT REV");
  eq("a new revision sits alongside", (await w.Store.list("drawing", ".pdf")).length, 2);

  // NB: Buffer.from(s).buffer is the shared allocation pool, not just these
  // bytes — encode instead, the way a real File.arrayBuffer() would.
  const bytes = s => new TextEncoder().encode(s);
  const a = await w.sha256(bytes("hello"));
  const b = await w.sha256(bytes("hello"));
  const c = await w.sha256(bytes("hellp"));
  eq("hash is stable", a, b);
  ok("hash changes with the bytes", a !== c);
  ok("hash is 64 hex chars", /^[0-9a-f]{64}$/.test(a));
}

/* ============================ 26. publish from the app ============================ */
{
  const { w, $, dir } = await bootWithFolder();
  addChar(w); addChar(w);
  w.S.layout.part.partNo = "DEMO-1042";
  w.S.layout.part.rev = "C";
  w.S.layout.drawing = { file: "DEMO-1042_REVC.pdf", sha256: "abc", pages: 2 };
  w.S.bytes = new TextEncoder().encode("%PDF-1.7 fake").buffer;
  w.paintJob();

  ok("publish offered before anything is published", $("jobAct").hidden === false);
  eq("action is publish v1", $("jobAct").dataset.do, "publish");
  ok("button names the version", /Publish layout v1/.test($("jobAct").textContent));

  await w.publishJob();
  eq("layout landed in the folder", w.S.job.version, 1);
  const lay = await w.Store.readLayout();
  eq("published layout carries the chars", lay.chars.length, 2);
  eq("published layout carries the part", lay.part.partNo, "DEMO-1042");
  eq("published layout pins the drawing", lay.drawing.file, "DEMO-1042_REVC.pdf");
  ok("the drawing was copied in", await w.Store.exists("drawing", "DEMO-1042_REVC.pdf"));

  w.paintJob();
  ok("nothing to publish once published", $("jobAct").hidden === true);

  // editing the layout offers a new version
  w.S.balloons[0].req = "changed";
  w.paintJob();
  eq("an edit offers v2", $("jobAct").dataset.do, "publish");
  ok("button names v2", /Publish layout v2/.test($("jobAct").textContent));
  await w.publishJob();
  eq("two versions on file", (await w.Store.layoutVersions()).length, 2);
}

/* ============================ 27. saving a record from the app ============================ */
{
  const { w, $ } = await bootWithFolder();
  addChar(w); addChar(w);
  w.S.layout.drawing = { file: "d.pdf", sha256: "x", pages: 1 };
  w.S.bytes = new TextEncoder().encode("pdf").buffer;
  await w.publishJob();

  w.S.balloons[0].actual = "1.2512";
  w.paintJob();
  eq("with results, the action is save", $("jobAct").dataset.do, "save");

  // refuses without a unit id
  await w.saveRecord();
  eq("no record written without a unit id", (await w.Store.listRecords()).length, 0);

  w.S.record.unitId = "1042-0007";
  await w.saveRecord();
  const recs = await w.Store.listRecords();
  eq("record written", recs.length, 1);
  eq("record names the unit", recs[0].unitId, "1042-0007");
  eq("record carries the actual", Object.values(recs[0].results)[0].actual, "1.2512");
  eq("record stamps the layout version", recs[0].layoutVersion, 1);
  eq("unit count shown in the strip", w.S.job.records, 1);
  ok("saving to the folder clears dirty", w.dirty() === false);
  ok("strip mentions the unit", /1 unit recorded/.test($("jobStat").textContent));
}

/* ============================ 28. duplicates across the folder ============================ */
{
  const { w, $ } = await bootWithFolder();
  addChar(w);
  w.S.layout.drawing = { file: "d.pdf", sha256: "x", pages: 1 };
  w.S.bytes = new TextEncoder().encode("pdf").buffer;
  await w.publishJob();

  // a unit recorded by someone else, in an earlier session
  await w.Store.writeRecord({ unitId: "1042-0007", seq: 1, results: {}, date: "2026-07-30" });

  eq("no prior units for a fresh id", (await w.priorUnits("1042-0009")).length, 0);
  eq("the folder is searched, not just the tab", (await w.priorUnits("1042-0007")).length, 1);
  eq("match ignores case", (await w.priorUnits("1042-0007".toUpperCase())).length, 1);

  $("u_id").value = "1042-0007";
  $("u_id").oninput({ target: $("u_id") });
  await $("u_id").onchange();
  eq("another session's unit bumps the number", w.S.record.seq, 2);
  ok("flagged as re-inspection", w.S.record.rework === true);
  ok("warning names the folder", /job folder/.test($("u_warn").textContent));

  // and the re-inspection writes its own file
  w.S.balloons[0].actual = "1.25";
  await w.saveRecord();
  const files = (await w.Store.listRecords()).map(r => r.file).sort();
  eq("re-inspection is a separate file", files, ["1042-0007.json", "1042-0007_r2.json"]);
}

/* ============================ 29. reconnecting to a job ============================ */
{
  const { w, dir } = await bootWithFolder();
  addChar(w); addChar(w); addChar(w);
  w.S.layout.part.partNo = "DEMO-1042";
  w.S.layout.drawing = { file: "", sha256: "", pages: 0 };   // no drawing to fetch
  await w.publishJob();
  w.S.record.unitId = "1042-0007";
  w.S.balloons[0].actual = "1.25";
  await w.saveRecord();

  // a second person opens the same folder in a fresh tab
  const two = boot();
  two.w.showDirectoryPicker = async () => dir;
  await two.w.Store.attach(dir);
  await two.w.loadFromStore();

  eq("layout came back", two.w.S.balloons.length, 3);
  eq("part identity came back", two.w.S.layout.part.partNo, "DEMO-1042");
  eq("version noted", two.w.S.job.version, 1);
  eq("existing units counted", two.w.S.job.records, 1);
  eq("drops into inspect mode", two.w.S.view, "inspect");
  eq("starts with no results of its own", two.w.S.balloons.filter(b => b.actual).length, 0);
  ok("a freshly loaded job is clean", two.w.dirty() === false);
  ok("nothing to publish on arrival", two.$("jobAct").hidden === true);
}

/* ============================ 30. the drawing was swapped ============================ */
{
  const { w, dir } = await bootWithFolder();
  const real = new TextEncoder().encode("%PDF REV C");
  await w.Store.putDrawing("DEMO-1042.pdf", real);
  addChar(w);
  w.S.layout.drawing = { file: "DEMO-1042.pdf", sha256: await w.sha256(real), pages: 1 };
  await w.publishJob();

  const lay = await w.Store.readLayout();
  ok("layout stores the drawing hash", /^[0-9a-f]{64}$/.test(lay.drawing.sha256));

  // someone drops rev D over rev C
  const dd = await dir.getDirectoryHandle("drawing");
  const h = await dd.getFileHandle("DEMO-1042.pdf");
  const wr = await h.createWritable(); await wr.write(new TextEncoder().encode("%PDF REV D")); await wr.close();

  const swapped = await w.Store.readBytes("drawing", "DEMO-1042.pdf");
  ok("the hash no longer matches", (await w.sha256(swapped)) !== lay.drawing.sha256);
}

/* ============================ 31. folder strip states ============================ */
{
  // no folder API at all — the tool still works from files
  const { w, $ } = boot();
  ok("unsupported browser is stated plainly", /can't open a job folder/.test($("jobStat").textContent));
  ok("open button hidden when unsupported", $("jobOpen").hidden === true);
  ok("no action offered", $("jobAct").hidden === true);

  // API present, nothing attached
  const b = boot();
  useMemoryHandles(b.w);
  b.w.showDirectoryPicker = async () => { throw new Error("cancelled"); };
  b.w.paintJob();
  ok("prompts to connect", /not connected/.test(b.$("jobName").textContent));
  ok("open button offered", b.$("jobOpen").hidden === false);

  await b.w.openJob();          // user cancels the picker
  ok("a cancelled picker leaves things alone", b.w.Store.attached === false);

  // attached
  const c = await bootWithFolder();
  c.w.paintJob();
  ok("folder name shown", c.$("jobName").textContent === "DEMO-1042");
  ok("says no layout yet", /no layout published/.test(c.$("jobStat").textContent));
  ok("button offers to change folder", /Change/.test(c.$("jobOpen").textContent));
}

/* ============================ 32. the share goes away ============================ */
{
  const { w, $ } = await bootWithFolder();
  addChar(w);
  w.S.layout.drawing = { file: "d.pdf", sha256: "x", pages: 1 };
  w.S.bytes = new TextEncoder().encode("pdf").buffer;
  await w.publishJob();
  w.S.record.unitId = "SN-1";
  w.S.balloons[0].actual = "1.25";

  // simulate the network dropping mid-shift
  w.Store.root.getDirectoryHandle = async () => { throw new Error("NetworkError"); };
  await w.saveRecord();
  ok("a dead share doesn't throw", true);
  ok("the results are still on screen", w.S.balloons[0].actual === "1.25");
  ok("still marked unsaved so nothing looks written", w.dirty() === true);
  ok("the operator is told to export instead", /export it to a file/.test($("toast").textContent));
}

/* ============================ 33. remembering the folder ============================ */
{
  // the real Handles, against a real (fake-indexeddb) database. A live
  // FileSystemDirectoryHandle is structured-cloneable in Chrome; the test
  // fake isn't, so this uses a plain object to exercise the storage path.
  const { w } = boot();
  ok("nothing remembered to start with", (await w.Handles.last()) == null);

  await w.Handles.remember({ name: "DEMO-1042" });
  const back = await w.Handles.last();
  ok("the folder is remembered", !!back);
  eq("and comes back intact", back.name, "DEMO-1042");

  await w.Handles.remember({ name: "DEMO-2000" });
  eq("remembering again replaces it", (await w.Handles.last()).name, "DEMO-2000");

  await w.Handles.forget();
  ok("forget clears it", (await w.Handles.last()) == null);

  // private browsing, a blocked database, an unserialisable handle — none of
  // this is load-bearing, so all of it has to fail quietly
  const q = boot();
  q.w.indexedDB = undefined;
  ok("no database is survivable", (await q.w.Handles.last()) == null);
  await q.w.Handles.remember({ name: "X" });
  await q.w.Handles.forget();
  ok("and writing to it doesn't throw", true);

  const r = boot();
  await r.w.Handles.remember({ fn(){} });      // functions can't be cloned
  ok("an unstorable handle fails quietly", (await r.w.Handles.last()) == null);

  // connecting to a folder remembers it
  const c = await bootWithFolder();
  eq("connecting remembers the folder", (await c.w.Handles.last()).name, "DEMO-1042");
}

/* ============================ 34. reconnecting on load ============================ */
{
  // set a job up and leave some work in the folder
  const first = await bootWithFolder();
  addChar(first.w); addChar(first.w);
  first.w.S.layout.part.partNo = "DEMO-1042";
  first.w.S.layout.drawing = { file: "", sha256: "", pages: 0 };
  await first.w.publishJob();
  first.w.S.record.unitId = "1042-0007";
  first.w.S.balloons[0].actual = "1.25";
  await first.w.saveRecord();
  const remembered = await first.w.Handles.last();

  // ---- a soft reload: permission still stands, so it just picks up ----
  const soft = boot();
  useMemoryHandles(soft.w);
  soft.w.showDirectoryPicker = async () => remembered;
  await soft.w.Handles.remember(remembered);
  await soft.w.restoreJob();
  ok("still-permitted folder reattaches on its own", soft.w.Store.attached === true);
  eq("the layout came with it", soft.w.S.balloons.length, 2);
  eq("so did the record count", soft.w.S.job.records, 1);
  ok("no reconnect button needed", soft.$("jobBack").hidden === true);
  ok("nothing left to recall", soft.w.S.recall === null);

  // ---- after a browser restart: permission has lapsed ----
  const cold = boot();
  useMemoryHandles(cold.w);
  const lapsed = fakeDir("DEMO-1042");
  await lapsed.getDirectoryHandle("layout", { create: true });
  await lapsed.getDirectoryHandle("records", { create: true });
  lapsed._perm = "prompt";
  cold.w.showDirectoryPicker = async () => lapsed;
  await cold.w.Handles.remember(lapsed);
  await cold.w.restoreJob();

  ok("lapsed folder does not silently reattach", cold.w.Store.attached === false);
  ok("but it is offered back", cold.$("jobBack").hidden === false);
  ok("the button names the folder", /Reconnect to DEMO-1042/.test(cold.$("jobBack").textContent));
  ok("the strip shows the folder name", cold.$("jobName").textContent === "DEMO-1042");
  ok("and says what it is", /last job/.test(cold.$("jobStat").textContent));

  await cold.w.reconnectJob();
  ok("one click gets back in", cold.w.Store.attached === true);
  ok("reconnect button goes away", cold.$("jobBack").hidden === true);
  ok("recall cleared", cold.w.S.recall === null);
}

/* ============================ 35. reconnect refused or gone ============================ */
{
  // the user says no at the permission prompt
  const a = boot();
  useMemoryHandles(a.w);
  a.w.showDirectoryPicker = async () => fakeDir("stub");
  const denied = fakeDir("DEMO-1042");
  denied._perm = "denied";
  denied.requestPermission = async () => "denied";
  await a.w.Handles.remember(denied);
  await a.w.restoreJob();
  ok("denied folder is still offered", a.$("jobBack").hidden === false);

  await a.w.reconnectJob();
  ok("refusing leaves us disconnected", a.w.Store.attached === false);
  ok("the offer stays for another try", a.w.S.recall !== null);
  ok("the user is told what to do", /Open/.test(a.$("toast").textContent));

  // the folder was moved or the share dropped
  const b = boot();
  useMemoryHandles(b.w);
  b.w.showDirectoryPicker = async () => fakeDir("stub");
  const gone = fakeDir("DEMO-1042");
  gone._perm = "prompt";
  gone.getDirectoryHandle = async () => { throw new Error("NotFoundError"); };
  gone.entries = () => ({ async next() { throw new Error("NotFoundError"); } });
  await b.w.Handles.remember(gone);
  await b.w.restoreJob();
  await b.w.reconnectJob();
  ok("a vanished folder leaves us disconnected", b.w.Store.attached === false);
  ok("the dead offer is dropped", b.w.S.recall === null);
  ok("and forgotten, so it won't be offered again", (await b.w.Handles.last()) == null);
  ok("the message says what happened", /moved, renamed, or the share dropped/.test(b.$("toast").textContent));
  b.w.paintJob();
  ok("back to the plain not-connected state", /not connected/.test(b.$("jobName").textContent));
}

/* ============================ 36. nothing remembered ============================ */
{
  const { w, $ } = boot();
  useMemoryHandles(w);
  w.showDirectoryPicker = async () => fakeDir("X");
  await w.restoreJob();
  ok("no stored folder means no offer", $("jobBack").hidden === true);
  ok("nothing recalled", w.S.recall === null);
  ok("still disconnected", w.Store.attached === false);

  // and picking one by hand clears any stale offer
  w.S.recall = { handle: fakeDir("OLD"), name: "OLD" };
  await w.openJob();
  ok("an explicit pick wins", w.Store.attached === true);
  ok("the stale offer is dropped", w.S.recall === null);
  ok("no reconnect button while attached", $("jobBack").hidden === true);
}

/* ============================ 37. the title block folds ============================ */
{
  const { w, $ } = boot();
  ok("starts open on a blank sheet", $("tbGrid").hidden === false);
  ok("section carries the open class", $("titleblock").classList.contains("open"));
  ok("summary hidden while open", $("tbSum").hidden === true);
  ok("aria reflects the state", $("tbToggle").getAttribute("aria-expanded") === "true");

  $("tbToggle").onclick();
  ok("folds away", $("tbGrid").hidden === true);
  ok("open class comes off", $("titleblock").classList.contains("open") === false);
  ok("summary takes over", $("tbSum").hidden === false);
  ok("aria follows", $("tbToggle").getAttribute("aria-expanded") === "false");
  ok("empty summary says so", /no part details yet/.test($("tbSum").textContent));
  ok("empty summary is styled as absent", $("tbSum").classList.contains("none"));

  $("tbToggle").onclick();
  ok("opens again", $("tbGrid").hidden === false);
}

/* ============================ 38. what the summary says ============================ */
{
  const { w, $ } = boot();
  const type = (id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event("input")); };
  type("h_partNo", "DEMO-1042");
  type("h_rev", "C");
  type("h_partName", "MANIFOLD BODY");
  type("h_insp", "B. Fosbinder");
  type("h_date", "2026-08-01");
  type("h_order", "4500123");
  $("tbToggle").onclick();

  const txt = $("tbSum").textContent;
  ok("part number and rev on one line", /DEMO-1042 REV C/.test(txt));
  ok("part name too", /MANIFOLD BODY/.test(txt));
  ok("inspector on the second line", /B\. Fosbinder/.test(txt));
  ok("date too", /2026-08-01/.test(txt));
  ok("order labelled", /order 4500123/.test(txt));
  ok("not styled as absent", $("tbSum").classList.contains("none") === false);

  // it keeps up while you type
  type("h_rev", "D");
  ok("summary tracks edits live", /DEMO-1042 REV D/.test($("tbSum").textContent));

  // no rev, no dangling "REV"
  type("h_rev", "");
  ok("no rev, no stray label", !/REV/.test($("tbSum").textContent));
}

/* ============================ 39. folds itself for the operator ============================ */
{
  const { w, $ } = boot();
  addChar(w);
  w.S.layout.part.partNo = "DEMO-1042";
  w.S.layout.part.rev = "C";
  const filled = JSON.parse(JSON.stringify(w.fileObject(true)));

  const two = boot();
  two.w.adopt(filled);
  ok("a filled-in layout arrives folded", two.$("tbGrid").hidden === true);
  ok("with the part named in the summary", /DEMO-1042 REV C/.test(two.$("tbSum").textContent));

  // a layout with no part number still needs filling in, so it opens
  const bare = JSON.parse(JSON.stringify(filled));
  bare.layout.part.partNo = "";
  bare.layout.part.rev = "";
  const three = boot();
  three.w.adopt(bare);
  ok("an unnamed layout opens for editing", three.$("tbGrid").hidden === false);
}

/* ============================ 40. hiding actually hides ============================ */
{
  // The UA stylesheet's `[hidden]{display:none}` loses to any author rule that
  // sets an explicit display, so `.tb-grid{display:grid}` quietly beat it and
  // the panel never collapsed. Asserting el.hidden === true didn't catch that,
  // because the property was set correctly — the CSS just ignored it. This
  // checks the stylesheet instead.
  const style = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
  const rules = new Map();
  style.replace(/\/\*[\s\S]*?\*\//g, "").split("}").forEach(chunk => {
    const i = chunk.indexOf("{");
    if (i < 0) return;
    const m = chunk.slice(i + 1).match(/(?:^|;)\s*display\s*:\s*([\w-]+)/);
    if (!m) return;
    chunk.slice(0, i).split(",").map(x => x.trim()).filter(Boolean)
      .forEach(sel => rules.set(sel, m[1]));
  });

  // everything the app toggles out of view, however it names the element
  const HIDES = ["tbGrid", "tbSum", "lockbar", "savestate", "u_warn", "u_seq",
                 "jobAct", "jobBack", "jobOpen", "expMenu", "toast", "sheet", "hint",
                 "alert", "parts", "partFilter", "prog", "alertAct"];
  const { w } = boot();
  const doc = w.document;

  // the list has to stay honest as the app grows
  const found = new Set([...html.matchAll(/\$\("(\w+)"\)\.hidden\s*=/g)].map(m => m[1]));
  const missing = [...found].filter(id => !HIDES.includes(id));
  ok("every hidden element is on the list", missing.length === 0, missing.join(", "));

  for (const id of HIDES) {
    const el = doc.getElementById(id);
    if (!el) { ok(`${id} exists`, false); continue; }
    const sels = ["#" + id, ...[...el.classList].map(c => "." + c)];
    const explicit = sels.filter(s => rules.get(s) && rules.get(s) !== "none");
    if (!explicit.length) { pass++; continue; }        // nothing overrides [hidden]
    const covered = explicit.every(s => rules.get(s + "[hidden]") === "none");
    ok(`${id} disappears when hidden (${explicit.join(" ")} sets display)`, covered);
  }
}

/* ============================ 41. the role decides what's reachable ============================ */
{
  const { w, $ } = boot();
  eq("planner by default", w.S.role, "planner");
  ok("body isn't in operator mode", w.document.body.classList.contains("operator") === false);

  w.S.role = "operator";
  w.applyRole();
  ok("body marks operator mode", w.document.body.classList.contains("operator") === true);
  eq("forced into inspect", w.S.view, "inspect");

  // the spec is locked whether or not anything has been measured
  addChar(w);
  const only = w.S.balloons[0];
  ok("layout hard-locked with no results", w.locked() === true);

  // and the locks actually bite, not just report
  w.place({ x: 10, y: 10 });
  eq("can't add a characteristic", w.S.balloons.length, 1);
  w.remove(only.id);
  eq("can't delete one", w.S.balloons.length, 1);
  only.num = 9;
  $("renum").onclick();
  eq("can't renumber", w.S.balloons[0].num, 9);

  // the planner's Lay out view is read-only for an operator too, if reached
  w.setView("layout");
  const req = $("list").querySelector(".req");
  ok("the requirement field renders", !!req);
  ok("and is read-only", req.readOnly === true);
  ok("delete is disabled", $("list").querySelector(".kill").disabled === true);
  w.setView("inspect");

  // and the planner-only chrome is gone from the toolbar
  const planner = [...w.document.querySelectorAll(".planner-only")];
  ok("planner-only chrome exists to be hidden", planner.length >= 4);
  // the class has to actually hide things — same trap as .tb-grid
  const sheet = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  ok("operator mode hides planner chrome in CSS",
     /body\.operator\s+\.planner-only\s*\{[^}]*display\s*:\s*none\s*!important/.test(sheet));
  ok("the export menu is planner-only", $("expMenu").closest(".planner-only") != null);
  ok("the lay-out toggle is planner-only", $("vLay").closest(".planner-only") != null);
  ok("open drawing is planner-only", $("open").classList.contains("planner-only"));
  ok("renumber is planner-only", $("renum").classList.contains("planner-only"));

  w.S.role = "planner";
  w.applyRole();
  ok("planner gets the layout back", w.locked() === false);
}

/* ============================ 42. choosing a part ============================ */
{
  const { w, $ } = boot();
  w.showDirectoryPicker = async () => null;
  useMemoryHandles(w);

  // an inspection folder holding three parts, in a deliberately awkward order
  const root = fakeDir("Inspection");
  const mk = async (name, versions, records) => {
    const d = await root.getDirectoryHandle(name, { create: true });
    if (versions || records) {
      const lay = await d.getDirectoryHandle("layout", { create: true });
      for (let i = 1; i <= versions; i++) {
        const h = await lay.getFileHandle("v" + i + ".json", { create: true });
        const wr = await h.createWritable(); await wr.write("{}"); await wr.close();
      }
      const rec = await d.getDirectoryHandle("records", { create: true });
      for (let i = 1; i <= records; i++) {
        const h = await rec.getFileHandle("SN-" + i + ".json", { create: true });
        const wr = await h.createWritable(); await wr.write("{}"); await wr.close();
      }
    }
    return d;
  };
  await mk("DEMO-1042", 2, 3);
  await mk("5116", 1, 0);
  await mk("scratch", 0, 0);

  await w.attachRoot(root);
  ok("the picker is showing", $("parts").hidden === false);
  ok("with a search box", $("partFilter").hidden === false);

  const rows = [...$("parts").querySelectorAll(".part")];
  eq("every folder is listed", rows.length, 3);
  eq("sorted naturally", rows.map(r => r.querySelector("b").textContent), ["5116", "DEMO-1042", "scratch"]);
  ok("layout version shown", /layout v2/.test(rows[1].textContent));
  ok("unit count shown", /3 units/.test(rows[1].textContent));
  ok("a part with no units reads singular-safe", /0 units/.test(rows[0].textContent));
  ok("an unprepared folder is marked", rows[2].classList.contains("bare"));
  ok("and says so", /not set up/.test(rows[2].textContent));

  // the filter
  $("partSearch").value = "51";
  $("partSearch").oninput();
  eq("filter narrows the list", $("parts").querySelectorAll(".part").length, 1);
  $("partSearch").value = "zzz";
  $("partSearch").oninput();
  ok("no match says so", /No part matches/.test($("parts").textContent));
  $("partSearch").value = "";
  $("partSearch").oninput();
  eq("clearing restores it", $("parts").querySelectorAll(".part").length, 3);

  // picking one opens it
  await w.pickPart("DEMO-1042");
  ok("picker closes", $("parts").hidden === true);
  ok("the part folder is open", w.Store.attached === true);
  eq("and it's the right one", w.Store.name, "DEMO-1042");

  // and there's a way back
  w.S.role = "operator"; w.applyRole();
  eq("operator is offered the part list", $("jobAct").dataset.do, "parts");
  ok("never offered publish", !/Publish/.test($("jobAct").textContent));
  w.backToParts();
  ok("back at the picker", $("parts").hidden === false);
  ok("and detached from the part", w.Store.attached === false);
  ok("but still holding the root", w.Store.hasRoot === true);
}

/* ============================ 43. progress ============================ */
{
  const { w, $ } = await bootWithFolder();
  w.S.role = "operator";
  addChar(w); addChar(w); addChar(w); addChar(w);
  w.applyRole(); w.paintProgress();

  ok("progress is showing", $("prog").hidden === false);
  ok("nothing measured yet", /0<\/b> of 4 measured/.test($("progN").innerHTML));
  ok("save is disabled with nothing measured", $("opSave").disabled === true);
  ok("and says why", /Nothing measured/.test($("opSave").textContent));

  w.S.balloons[0].actual = "1.2512";
  w.S.balloons[1].actual = "1.2600";       // out
  w.paintProgress();
  ok("counts everything measured", /2<\/b> of 4 measured/.test($("progN").innerHTML));
  ok("rejects called out", /1 out of tolerance/.test($("progBad").textContent));
  ok("save enabled once something is measured", $("opSave").disabled === false);
  ok("but says how many are left", /2 still open/.test($("opSave").textContent));
  eq("bar splits good from bad", $("progOk").style.width, "25%");
  eq("bad segment sized", $("progNo").style.width, "25%");

  w.S.balloons[2].actual = "1.25";
  w.S.balloons[3].actual = "1.25";
  w.paintProgress();
  ok("complete part offers a plain save", $("opSave").textContent === "Save this part");

  // a planner never sees any of it
  w.S.role = "planner"; w.applyRole();
  ok("no progress bar for the planner", $("prog").hidden === true);
}

/* ============================ 44. the operator's save rules ============================ */
{
  const mk = async () => {
    const c = await bootWithFolder();
    c.w.S.role = "operator";
    addChar(c.w); addChar(c.w); addChar(c.w);
    c.w.S.layout.drawing = { file: "d.pdf", sha256: "x", pages: 1 };
    c.w.S.bytes = new TextEncoder().encode("pdf").buffer;
    c.w.S.role = "planner";
    await c.w.publishJob();
    c.w.S.role = "operator";
    c.w.applyRole();
    c.w.paintList();
    return c;
  };

  // no unit id
  {
    const { w, $ } = await mk();
    w.S.balloons[0].actual = "1.25";
    await w.operatorSave();
    eq("nothing saved without a unit id", (await w.Store.listRecords()).length, 0);
    ok("and it's on the banner, not a toast", $("alert").hidden === false);
    ok("banner names the field", /serial no/i.test($("alertmsg").textContent));
  }

  // a reject with no note is blocked
  {
    const { w, $ } = await mk();
    w.S.record.unitId = "SN-1";
    w.S.balloons[0].actual = "1.25";
    w.S.balloons[1].actual = "1.2600";        // out, no note
    w.S.balloons[2].actual = "1.25";
    await w.operatorSave();
    eq("blocked", (await w.Store.listRecords()).length, 0);
    ok("banner explains", /out of tolerance/.test($("alertmsg").textContent));
    ok("banner names the characteristic", /Characteristic 2/.test($("alertmsg").textContent));
    eq("and the list filters to the rejects", w.S.filter, "bad");

    // add the note and it goes through
    w.S.balloons[1].note = "0.010 over, chased and re-cut";
    w.prompt = () => "rework per traveler";
    w.S.record.disposition = "";
    await w.operatorSave();
    const recs = await w.Store.listRecords();
    eq("saved once noted", recs.length, 1);
    ok("banner cleared", $("alert").hidden === true);
    const saved = await w.Store.readRecord(recs[0].file);
    eq("stamped as a reject", saved.status, "REJECT");
    eq("disposition recorded", saved.disposition, "rework per traveler");
    eq("the note went with it", Object.values(saved.results).filter(r => r.note).length, 1);
  }

  // cancelling the disposition prompt aborts the save
  {
    const { w } = await mk();
    w.S.record.unitId = "SN-2";
    w.S.balloons.forEach(b => b.actual = "1.25");
    w.S.balloons[1].actual = "1.99";
    w.S.balloons[1].note = "scrap";
    w.prompt = () => null;
    await w.operatorSave();
    eq("nothing written when the prompt is cancelled", (await w.Store.listRecords()).length, 0);
  }

  // an unfinished part saves, but says so
  {
    const { w } = await mk();
    w.S.record.unitId = "SN-3";
    w.S.balloons[0].actual = "1.25";
    w.confirm = () => true;
    await w.operatorSave();
    const recs = await w.Store.listRecords();
    eq("incomplete part is written", recs.length, 1);
    const saved = await w.Store.readRecord(recs[0].file);
    eq("and stamped INCOMPLETE", saved.status, "INCOMPLETE");
    eq("with the readings it does have", Object.keys(saved.results).length, 1);
  }

  // ...unless the operator backs out
  {
    const { w } = await mk();
    w.S.record.unitId = "SN-4";
    w.S.balloons[0].actual = "1.25";
    w.confirm = () => false;
    await w.operatorSave();
    eq("declining leaves it unwritten", (await w.Store.listRecords()).length, 0);
  }

  // a clean, complete part just saves
  {
    const { w, $ } = await mk();
    w.S.record.unitId = "SN-5";
    w.S.balloons.forEach(b => b.actual = "1.25");
    await w.operatorSave();
    const recs = await w.Store.listRecords();
    eq("written", recs.length, 1);
    const saved = await w.Store.readRecord(recs[0].file);
    eq("stamped ACCEPT", saved.status, "ACCEPT");
    eq("no disposition needed", saved.disposition, "");
    ok("no banner", $("alert").hidden === true);
    ok("clean", w.dirty() === false);
  }
}

/* ============================ 45. alerts stay until dismissed ============================ */
{
  const { w, $ } = boot();
  ok("no banner to start", $("alert").hidden === true);
  w.trouble("the share dropped");
  ok("banner up", $("alert").hidden === false);
  eq("with the message", $("alertmsg").textContent, "the share dropped");
  ok("and a toast too, for anyone watching", /share dropped/.test($("toast").textContent));

  // toasts time out; the banner does not
  w.say("something else");
  ok("banner survives a later toast", $("alert").hidden === false);
  $("alertx").onclick();
  ok("dismissed by hand", $("alert").hidden === true);
}

/* ============================ 46. the crash cache ============================ */
{
  const { w, $ } = await bootWithFolder();
  addChar(w); addChar(w); addChar(w);
  w.S.layout.drawing = { file: "d.pdf", sha256: "x", pages: 1 };
  w.S.bytes = new TextEncoder().encode("pdf").buffer;
  await w.publishJob();

  // nothing worth keeping yet
  await w.Cache.write();
  ok("an untouched part isn't cached", (await w.Cache.read()) == null);

  w.S.record.unitId = "SN-1";
  w.S.balloons[0].actual = "1.2512";
  w.S.balloons[0].note = "mic";
  await w.Cache.write();

  const d = await w.Cache.read();
  ok("work in progress is cached", !!d);
  eq("cached under the part folder", d.folder, "DEMO-1042");
  eq("with the unit id", d.record.unitId, "SN-1");
  eq("and the reading", Object.values(d.record.results)[0].actual, "1.2512");
  eq("and the note", Object.values(d.record.results)[0].note, "mic");
  eq("stamped with the layout version", d.layoutVersion, 1);
  ok("and a time", typeof d.when === "string");

  // clearing the work clears the cache
  w.S.record.unitId = "";
  w.S.balloons[0].actual = "";
  w.S.balloons[0].note = "";
  await w.Cache.write();
  ok("nothing left to keep, nothing kept", (await w.Cache.read()) == null);
}

/* ============================ 47. saving retires the draft ============================ */
{
  const { w } = await bootWithFolder();
  addChar(w);
  w.S.layout.drawing = { file: "d.pdf", sha256: "x", pages: 1 };
  w.S.bytes = new TextEncoder().encode("pdf").buffer;
  await w.publishJob();

  w.S.record.unitId = "SN-1";
  w.S.balloons[0].actual = "1.25";
  await w.Cache.write();
  ok("cached while in progress", (await w.Cache.read()) != null);

  await w.saveRecord();
  eq("the real record landed", (await w.Store.listRecords()).length, 1);
  ok("and the draft is gone", (await w.Cache.read()) == null);
}

/* ============================ 48. picking the work back up ============================ */
{
  // a shift's work, cached but never saved
  const first = await bootWithFolder();
  addChar(first.w); addChar(first.w); addChar(first.w);
  first.w.S.layout.part.partNo = "DEMO-1042";
  first.w.S.layout.drawing = { file: "", sha256: "", pages: 0 };
  await first.w.publishJob();
  first.w.S.record.unitId = "SN-7";
  first.w.S.record.inspector = "B. Fosbinder";
  first.w.S.balloons[0].actual = "1.2512";
  first.w.S.balloons[1].actual = "1.2600";
  first.w.S.balloons[1].note = "over";
  await first.w.Cache.write();
  const draft = await first.w.Cache.read();

  // Chrome dies. New tab, same folder.
  const two = boot();
  useMemoryHandles(two.w);
  two.w.showDirectoryPicker = async () => first.dir;
  await two.w.attachJob(first.dir);
  await two.w.Handles.tx("readwrite", st => st.put(draft, "draft:DEMO-1042"));

  eq("the layout came back but the readings didn't", two.w.S.balloons.filter(b => b.actual).length, 0);
  ok("the draft is offered", (await two.w.offerDraft()) === true);
  ok("on the banner", two.$("alert").hidden === false);
  ok("naming the unit", /SN-7/.test(two.$("alertmsg").textContent));
  ok("and the count", /2 readings/.test(two.$("alertmsg").textContent));
  ok("saying it never reached the folder", /never reached the folder/.test(two.$("alertmsg").textContent));
  ok("with a way to take it back", two.$("alertAct").hidden === false);

  two.$("alertAct").onclick();
  eq("readings restored", two.w.S.balloons.filter(b => b.actual).length, 2);
  eq("values intact", two.w.S.balloons[0].actual, "1.2512");
  eq("notes intact", two.w.S.balloons[1].note, "over");
  eq("unit id restored", two.w.S.record.unitId, "SN-7");
  eq("inspector restored", two.w.S.record.inspector, "B. Fosbinder");
  ok("banner cleared", two.$("alert").hidden === true);
  ok("and it's marked unsaved, because it is", two.w.dirty() === true);
}

/* ============================ 48b. the offer survives a background write ============================ */
{
  const { w, $ } = await bootWithFolder();
  addChar(w);
  w.S.layout.drawing = { file: "", sha256: "", pages: 0 };
  await w.publishJob();
  w.S.record.unitId = "SN-5";
  w.S.balloons[0].actual = "1.25";
  await w.Cache.write();

  // fresh screen, draft offered
  w.S.record.unitId = "";
  w.S.balloons[0].actual = "";
  ok("offered", (await w.offerDraft()) === true);

  // the debounced write fires while the banner sits there. The screen is empty
  // *because* the draft hasn't been restored — it must not erase it.
  await w.Cache.write();
  ok("the draft survives", (await w.Cache.read()) != null);
  ok("banner still up", $("alert").hidden === false);

  $("alertAct").onclick();
  eq("and it can still be taken back", w.S.balloons[0].actual, "1.25");

  // once restored, a write keeps it rather than dropping it
  await w.Cache.write();
  ok("restored work stays cached", (await w.Cache.read()) != null);
}

/* ============================ 49. declining a draft ============================ */
{
  const { w, $ } = await bootWithFolder();
  addChar(w);
  w.S.layout.drawing = { file: "", sha256: "", pages: 0 };
  await w.publishJob();
  w.S.record.unitId = "SN-9";
  w.S.balloons[0].actual = "1.25";
  await w.Cache.write();

  // start clean, then turn the offer down
  w.S.record.unitId = "";
  w.S.balloons[0].actual = "";
  ok("offered", (await w.offerDraft()) === true);
  $("alertx").onclick();
  ok("banner gone", $("alert").hidden === true);
  ok("nothing restored", w.S.balloons[0].actual === "");
  ok("and the draft is discarded, not re-offered", (await w.Cache.read()) == null);
  ok("so a second look finds nothing", (await w.offerDraft()) === false);
}

/* ============================ 50. a draft from an older layout ============================ */
{
  const { w, $ } = await bootWithFolder();
  const a = addChar(w), b = addChar(w);
  w.S.layout.drawing = { file: "", sha256: "", pages: 0 };
  await w.publishJob();

  // work taken against v1
  w.S.record.unitId = "SN-3";
  a.actual = "1.25"; b.actual = "1.26";
  await w.Cache.write();

  // the layout is revised and a characteristic disappears
  w.S.revising = true;
  w.S.layout.version = 2;
  w.S.balloons = [a];
  a.actual = ""; b.actual = "";
  w.S.record.unitId = "";

  ok("still offered", (await w.offerDraft()) === true);
  ok("but flagged as a version behind", /layout v1/.test($("alertmsg").textContent));
  ok("naming the current version", /now on v2/.test($("alertmsg").textContent));

  $("alertAct").onclick();
  eq("what still fits is restored", w.S.balloons[0].actual, "1.25");
  ok("and the orphan is called out", $("alert").hidden === false);
  ok("in plain terms", /couldn't be placed/.test($("alertmsg").textContent));
  ok("with a warning to check the part", /Check the part/.test($("alertmsg").textContent));
}

/* ============================ 51. the cache is never load-bearing ============================ */
{
  // no IndexedDB at all — private mode, blocked db, whatever
  const { w } = boot();
  w.indexedDB = undefined;
  addChar(w);
  w.S.record.unitId = "SN-1";
  w.S.balloons[0].actual = "1.25";
  await w.Cache.write();
  ok("writing without a database doesn't throw", true);
  ok("reading gives nothing", (await w.Cache.read()) == null);
  ok("offering gives nothing", (await w.offerDraft()) === false);
  await w.Cache.clear();
  ok("clearing doesn't throw", true);
  eq("and the work is still on screen", w.S.balloons[0].actual, "1.25");
}

/* ============================ 52. one draft per part ============================ */
{
  const { w } = boot();
  useMemoryHandles(w);
  const root = fakeDir("Inspection");
  const mk = async n => {
    const d = await root.getDirectoryHandle(n, { create: true });
    await d.getDirectoryHandle("layout", { create: true });
    return d;
  };
  const p1 = await mk("DEMO-1042"), p2 = await mk("5116");

  await w.attachJob(p1);
  addChar(w);
  w.S.record.unitId = "SN-1";
  w.S.balloons[0].actual = "1.25";
  await w.Cache.write();

  await w.attachJob(p2);
  ok("a different part has no draft", (await w.Cache.read()) == null);
  addChar(w);
  w.S.record.unitId = "SN-2";
  w.S.balloons[0].actual = "9.99";
  await w.Cache.write();

  await w.attachJob(p1);
  const back = await w.Cache.read();
  eq("each part keeps its own", back.record.unitId, "SN-1");
  eq("and its own readings", Object.values(back.record.results)[0].actual, "1.25");
}

/* ============================ 53. the app knows its own name ============================ */
{
  const { w, $ } = boot();
  const brand = w.document.querySelector(".brand");
  const name = brand.querySelector("b").textContent;
  const rev = brand.querySelector("span").textContent.replace(/\u00a0/g, " ");

  eq("the toolbar names the app", name, "Balloon");
  ok("and shows a revision", /^rev \d+$/.test(rev), rev);

  // every saved file is stamped with this, so the two must not drift
  addChar(w);
  const stamp = w.fileObject(true).meta.app;
  eq("saved files carry the same name and revision", stamp, name + " " + rev);
}

/* ============================ 21. no-drawing safety ============================ */
{
  const { w, saved, $ } = boot();
  $("eCsv").onclick();
  $("eJson").onclick();
  $("eLayout").onclick();
  $("eLog").onclick();
  eq("nothing exports on an empty sheet", saved.length, 0);
  ok("empty state message", /No characteristics yet/.test($("list").textContent));

  $("u_new").onclick();
  eq("next unit does nothing with no layout", w.S.log.length, 0);
}

}

main().then(() => {
  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}).catch(e => { console.error(e); process.exit(1); });
