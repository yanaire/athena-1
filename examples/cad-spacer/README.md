# CadQuery spacer experiment

Start the local program in a Python environment with CadQuery installed.

```sh
python server.py
```

In an Athena project, open **Settings → Tools & plugins**, import `plugin.json`, check the **CadQuery / Open CASCADE** connection, then enable the package. In chat type `$cad`, select `$cad-spacer/measure`, and send a request such as “Compare 8, 12 and 16 mm bores in a 30 mm diameter, 6 mm thick spacer.”

The program builds one annular solid per bore, exports each as STEP, imports it back and measures its volume. The worker’s published `mcp-result.json` includes the measured and calculated volumes and the exact STEP text and SHA-256 for each model. The example uses a loopback-only server and accepts numeric dimensions.

To repeat the recorded browser check, install the project's QA Playwright dependency and its Chromium browser, then run the following from the repository root. The test uses a controlled local model provider, starts a real CadQuery server and writes the STEP files, measurements and browser recording to the evidence directory.

```sh
ATHENA_BROWSER_EVIDENCE=./cad-evidence node athena-backend-handoff/athena-codex-ui/qa/cad-skills-browser-test.mjs
```

Set `ATHENA_CAD_PAPER=1` to also draft a paper from the measured volumes, independently review its exact revision, compile it with the host’s LaTeX engine and download its PDF, TeX and review record.

Set `ATHENA_CAD_PYTHON` to the Python executable that has CadQuery installed if it differs from `python3`.
