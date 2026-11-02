// Runs the Python engine (engine.py + pilot.py) in Pyodide, off the page's main thread.
// Nothing here talks to any server except the CDN that serves Pyodide and this site's own engine files.
const PYODIDE = "https://cdn.jsdelivr.net/npm/pyodide@0.29.3/";
const FILES = ["engine.py", "pilot.py", "senders.json", "labels.json", "rules.json", "excluded_hashes.json"];

importScripts(PYODIDE + "pyodide.js");

const ready = (async () => {
  // 0.29+: older Pyodide fails to start under a Hebrew browser locale (he-IL)
  const py = await loadPyodide({ indexURL: PYODIDE, env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONUTF8: "1" } });
  py.FS.mkdirTree("/engine");
  for (const f of FILES) {
    const r = await fetch("engine/" + f, { cache: "no-cache" });
    if (!r.ok) throw new Error("missing engine file " + f);
    py.FS.writeFile("/engine/" + f, await r.text());
  }
  py.runPython("import sys; sys.path.insert(0, '/engine'); import pilot");
  return py;
})();

ready.then(() => postMessage({ type: "ready" }), (e) => postMessage({ type: "error", error: String(e) }));

onmessage = async (ev) => {
  if (ev.data.type !== "run") return;
  try {
    const py = await ready;
    py.globals.set("payload_json", JSON.stringify(ev.data.payload));
    const out = py.runPython("pilot.run(payload_json)");
    postMessage({ type: "result", result: JSON.parse(out) });
  } catch (e) {
    postMessage({ type: "error", error: String(e) });
  }
};
