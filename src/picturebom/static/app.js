// pictureBOM GUI — vanilla JS

(function () {
    const form = document.getElementById("bomForm");
    const runBtn = document.getElementById("runBtn");
    const setupSteps = document.getElementById("setupSteps");
    const runSteps = document.getElementById("runSteps");
    const summaryStep = document.getElementById("summaryStep");
    const progressSection = document.getElementById("progressSection");
    const progressNode = document.getElementById("progressNode");
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");
    const progressCount = document.getElementById("progressCount");
    const logEl = document.getElementById("log");
    const resultsSection = document.getElementById("resultsSection");
    const resultInfo = document.getElementById("resultInfo");
    const downloadLink = document.getElementById("downloadLink");
    const downloadHtmlLink = document.getElementById("downloadHtmlLink");
    const resultWarnings = document.getElementById("resultWarnings");
    const openFolderBtn = document.getElementById("openFolderBtn");
    const gallerySection = document.getElementById("gallerySection");
    const gallery = document.getElementById("gallery");
    const previewBox = document.getElementById("previewBox");
    const previewLabel = document.getElementById("previewLabel");
    const customSizeEl = document.getElementById("customSize");
    const estimateInfo = document.getElementById("estimateInfo");
    const timingInfo = document.getElementById("timingInfo");
    const elapsedTimeEl = document.getElementById("elapsedTime");
    const remainingTimeEl = document.getElementById("remainingTime");
    const assemblyInput = document.getElementById("assembly_path");
    const assemblyMsg = document.getElementById("assemblyMsg");

    // Timing state
    let runStartTime = null;
    let elapsedInterval = null;
    let componentTimes = [];
    let preRunEstimate = null;
    let jobRunning = false;
    let lastRunSidecar = false; // was sidecar explicitly requested this run?

    // -----------------------------------------------------------------------
    // Theme toggle — persisted per browser, defaults to the OS preference
    // (an inline <head> script sets data-theme before first paint)
    // -----------------------------------------------------------------------

    const THEME_KEY = "picturebom-theme"; // must match the inline boot script in index.html
    const themeToggle = document.getElementById("themeToggle");
    let themeTransitionTimer = null;

    function setTheme(theme) {
        document.documentElement.classList.add("theme-transition");
        document.documentElement.setAttribute("data-theme", theme);
        clearTimeout(themeTransitionTimer);
        themeTransitionTimer = setTimeout(function () {
            document.documentElement.classList.remove("theme-transition");
        }, 300);
    }

    if (themeToggle) {
        themeToggle.addEventListener("click", () => {
            const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
            setTheme(next);
            try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
        });
    }

    // Follow OS theme changes only until the user makes an explicit choice
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
        let stored = null;
        try { stored = localStorage.getItem(THEME_KEY); } catch (err) {}
        if (stored !== "light" && stored !== "dark") setTheme(e.matches ? "dark" : "light");
    });

    // -----------------------------------------------------------------------
    // View switching — Generate BOM | Compare BOMs
    // -----------------------------------------------------------------------

    document.querySelectorAll("[data-view-btn]").forEach(btn => {
        btn.addEventListener("click", () => {
            const view = btn.dataset.viewBtn;
            document.querySelectorAll("[data-view-btn]").forEach(b => {
                b.classList.toggle("is-active", b.dataset.viewBtn === view);
            });
            document.querySelectorAll("[data-view]").forEach(p => {
                p.classList.toggle("is-active", p.dataset.view === view);
            });
        });
    });

    // -----------------------------------------------------------------------
    // Step nodes + inline field messages
    // -----------------------------------------------------------------------

    // Nodes render their check (.node-complete::after) and pulsing dot
    // (.node-run::after) purely in CSS, so state changes are class toggles.
    function setNodeDone(node, done, label) {
        if (!node || node.classList.contains("node-complete") === done) return;
        node.classList.toggle("node-complete", done);
        node.textContent = done ? "" : label;
    }

    function setProgressNode(state) {
        progressNode.classList.remove("node-run", "node-complete", "node-error");
        progressNode.classList.add("node-" + state);
        progressNode.textContent = state === "error" ? "!" : "";
    }

    function showFieldMsg(el, kind, text) {
        el.textContent = text;
        el.classList.remove("hidden", "err", "warn");
        el.classList.add(kind);
    }

    function hideFieldMsg(el) {
        el.classList.add("hidden");
        el.classList.remove("err", "warn");
        el.textContent = "";
    }

    // Step 1 — advisory pre-flight checklist (session-only, never persisted)
    const readyChecks = Array.from(document.querySelectorAll(".ready-check"));
    const readyTally = document.getElementById("readyTally");
    const node1 = document.getElementById("node1");

    function updateReady() {
        const n = readyChecks.filter(c => c.checked).length;
        readyTally.textContent = n + " of " + readyChecks.length + " ready";
        readyTally.classList.toggle("ok", n === readyChecks.length);
        setNodeDone(node1, n === readyChecks.length, "1");
    }
    readyChecks.forEach(c => c.addEventListener("change", updateReady));

    // Step 2 — files
    const node2 = document.getElementById("node2");

    function refreshAssemblyField() {
        const value = assemblyInput.value.trim();
        setNodeDone(node2, value !== "", "2");
        if (value && !/\.sldasm$/i.test(value)) {
            showFieldMsg(assemblyMsg, "warn",
                "That doesn't look like a .sldasm file — pictureBOM needs the assembly, not a part or drawing.");
        } else {
            hideFieldMsg(assemblyMsg);
        }
    }
    assemblyInput.addEventListener("input", refreshAssemblyField);

    // -----------------------------------------------------------------------
    // "?" explanations on the Advanced options
    // -----------------------------------------------------------------------

    function setTip(tip, open) {
        tip.classList.toggle("is-open", open);
        const btn = tip.querySelector(".tipbtn");
        if (btn) btn.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function openTip() {
        return document.querySelector(".tip.is-open");
    }

    // The popup is a pseudo-element, so it cannot be clicked itself — a click
    // on it lands on whatever is underneath. This works out where the popup is
    // drawn so those clicks can be swallowed instead.
    function overPopup(tip, ev) {
        const cs = window.getComputedStyle(tip, "::after");
        const w = parseFloat(cs.width);
        const h = parseFloat(cs.height);
        const r = tip.getBoundingClientRect();
        const top = tip.classList.contains("tip-up") ? r.top - 2 - h : r.bottom + 2;
        return ev.clientX >= r.left && ev.clientX <= r.left + w &&
               ev.clientY >= top && ev.clientY <= top + h;
    }

    // Capture phase, so the click never reaches the label it is sitting on —
    // otherwise opening a popup (or dismissing one drawn over another option)
    // would silently flip a checkbox.
    document.addEventListener("click", function (ev) {
        const btn = ev.target.closest(".tipbtn");
        const open = openTip();
        if (!btn && !open) return;
        if (btn || overPopup(open, ev)) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        if (open) setTip(open, false);
        const tip = btn && btn.closest(".tip");
        if (tip && tip !== open) setTip(tip, true);
    }, true);

    document.addEventListener("keydown", function (ev) {
        const open = ev.key === "Escape" && openTip();
        if (open) setTip(open, false);
    });

    // -----------------------------------------------------------------------
    // Quality presets + preview box
    // -----------------------------------------------------------------------

    // Max resolution maps to the full viewport frame (208x117 minus the border)
    const MAX_W = 3840;
    const MAX_H = 2160;
    const BOX_MAX_W = 204;
    const BOX_MAX_H = 113;

    function formatRes(w, h) {
        return w + " × " + h;
    }

    function updatePreview(w, h) {
        const scaleW = (w / MAX_W) * BOX_MAX_W;
        const scaleH = (h / MAX_H) * BOX_MAX_H;
        previewBox.style.width = Math.max(24, Math.round(scaleW)) + "px";
        previewBox.style.height = Math.max(14, Math.round(scaleH)) + "px";
        previewLabel.textContent = formatRes(w, h);
    }

    function getSelectedQuality() {
        return document.querySelector('input[name="quality"]:checked');
    }

    function getWidthHeight() {
        const radio = getSelectedQuality();
        if (radio && radio.value !== "custom") {
            return {
                w: parseInt(radio.dataset.w, 10),
                h: parseInt(radio.dataset.h, 10),
            };
        }
        return {
            w: parseInt(document.getElementById("width").value, 10) || 1920,
            h: parseInt(document.getElementById("height").value, 10) || 1080,
        };
    }

    // Step 3 — export options: human-readable labels for the run summary strip
    const QUALITY_LABELS = { draft: "Draft", standard: "Standard", high: "High quality", custom: "Custom" };
    const MODE_LABELS = { flat: "Parts only", nested: "Sub-assemblies", linked: "Linked workbook" };

    function getModeValue() {
        const radio = document.querySelector('input[name="assembly_mode"]:checked');
        return radio ? radio.value : "flat";
    }

    function getUpAxis() {
        const radio = document.querySelector('input[name="viewer_up_axis"]:checked');
        const letter = radio ? radio.value : "y";
        return (document.getElementById("up_axis_flip").checked ? "-" : "+") + letter;
    }

    function getOutputs() {
        return {
            excel: document.getElementById("output_excel").checked,
            html: document.getElementById("output_html").checked,
            viewerExports: document.getElementById("viewer_exports").checked,
            keepRawGlb: document.getElementById("keep_raw_glb").checked,
            htmlSidecar: document.getElementById("html_sidecar").checked,
            upAxis: getUpAxis(),
        };
    }

    // The 3D sub-options only mean something when the 3D output is on
    function refreshViewerExportsState() {
        const noHtml = !document.getElementById("output_html").checked;
        document.getElementById("viewer_exports").disabled = noHtml;
        document.getElementById("keep_raw_glb").disabled = noHtml;
        document.getElementById("html_sidecar").disabled = noHtml;
        document.getElementById("up_axis_flip").disabled = noHtml;
        document.querySelectorAll('input[name="viewer_up_axis"]').forEach(r => {
            r.disabled = noHtml;
        });
    }

    // -----------------------------------------------------------------------
    // Up-axis preview — a triad drawn the way the exported viewer will show
    // it, so "Z up" is something you can see rather than infer. Same colours
    // and letters as the viewer's corner gizmo (web/bomdom/axes.js); the two
    // are separate builds, so the projection maths is deliberately duplicated
    // rather than shared.
    // -----------------------------------------------------------------------

    const SVG_NS = "http://www.w3.org/2000/svg";
    const AXIS_UNIT = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    // Camera position for the "front" view of each up axis — mirrors
    // FRONT_FOR_UP in web/bomdom/scene.js.
    const FRONT_FOR_UP = {
        "+y": [0, 0, 1], "-y": [0, 0, -1],
        "+z": [0, -1, 0], "-z": [0, 1, 0],
        "+x": [0, 0, 1], "-x": [0, 0, 1],
    };

    const vScale = (v, k) => [v[0] * k, v[1] * k, v[2] * k];
    const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const vDot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const vCross = (a, b) => [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
    function vNorm(v) {
        const len = Math.hypot(v[0], v[1], v[2]) || 1;
        return vScale(v, 1 / len);
    }

    function svgEl(name, attrs) {
        const node = document.createElementNS(SVG_NS, name);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        return node;
    }

    function drawAxisPreview() {
        const box = document.getElementById("upAxisPreview");
        if (!box) return;
        const up = getUpAxis();
        const letter = up[1];
        const upVec = vScale(AXIS_UNIT[letter], up[0] === "-" ? -1 : 1);
        const front = FRONT_FOR_UP[up];
        const right = vCross(upVec, front);
        // Isometric eye, then the screen basis that eye implies.
        const eye = vNorm(vAdd(vAdd(front, right), upVec));
        const sx = vNorm(vCross(upVec, eye));
        const sy = vCross(eye, sx);

        const SIZE = 112, C = SIZE / 2, R = 34, BALL = 10;
        const svg = svgEl("svg", {
            width: SIZE, height: SIZE, viewBox: "0 0 " + SIZE + " " + SIZE,
            role: "img",
            "aria-label": (up[0] === "-" ? "Negative " : "") + letter.toUpperCase() +
                " points up in the 3D view",
        });

        // Screen-up guide: a dashed arrow up the middle, so the triad is read
        // against "this direction is up on your monitor".
        svg.appendChild(svgEl("path", { class: "axis-svg-guide", d: "M" + C + " " + (C - 4) + " V10" }));
        svg.appendChild(svgEl("path", {
            class: "axis-svg-guide-head",
            d: "M" + C + " 5 l4 6 h-8 z",
        }));
        const guideText = svgEl("text", {
            class: "axis-svg-guide-text", x: C + 7, y: 15,
        });
        guideText.textContent = "up";
        svg.appendChild(guideText);

        const arms = ["x", "y", "z"].map(key => {
            const v = AXIS_UNIT[key];
            return { key, x: C + vDot(v, sx) * R, y: C - vDot(v, sy) * R, depth: vDot(v, eye) };
        });
        arms.sort((a, b) => a.depth - b.depth); // back to front
        for (const arm of arms) {
            const g = svgEl("g", { class: "ax-" + arm.key });
            g.appendChild(svgEl("line", {
                class: "axis-svg-line", x1: C, y1: C, x2: arm.x.toFixed(2), y2: arm.y.toFixed(2),
            }));
            g.appendChild(svgEl("circle", {
                class: "axis-svg-ball", cx: arm.x.toFixed(2), cy: arm.y.toFixed(2), r: BALL,
            }));
            const label = svgEl("text", {
                class: "axis-svg-label", x: arm.x.toFixed(2), y: arm.y.toFixed(2),
                "text-anchor": "middle", dy: "0.35em",
            });
            label.textContent = arm.key.toUpperCase();
            g.appendChild(label);
            svg.appendChild(g);
        }

        box.innerHTML = "";
        box.appendChild(svg);
        const cap = document.getElementById("upAxisCaption");
        if (cap) {
            cap.innerHTML = "";
            const strong = document.createElement("span");
            strong.className = "ax-" + letter;
            strong.style.fontWeight = "700";
            strong.textContent = (up[0] === "-" ? "−" : "") + letter.toUpperCase();
            cap.appendChild(strong);
            cap.appendChild(document.createTextNode(" up when the file opens"));
        }
    }

    function outputsLabel() {
        const o = getOutputs();
        const up = " (" + (o.upAxis[0] === "-" ? "−" : "") + o.upAxis[1].toUpperCase() + " up)";
        if (o.excel && o.html) return "Excel + 3D HTML" + up;
        if (o.html) return "3D HTML only" + up;
        return "Excel";
    }

    function qualityLabel() {
        const quality = getSelectedQuality();
        return QUALITY_LABELS[quality ? quality.value : "standard"];
    }

    function modeLabel() {
        return MODE_LABELS[getModeValue()];
    }

    // One refresh for everything derived from the quality/mode selections
    function refreshQualityUI() {
        const quality = getSelectedQuality();
        customSizeEl.classList.toggle("hidden", !quality || quality.value !== "custom");
        const wh = getWidthHeight();
        updatePreview(wh.w, wh.h);
    }

    document.querySelectorAll('input[name="quality"]').forEach(radio => {
        radio.addEventListener("change", refreshQualityUI);
    });

    ["width", "height"].forEach(id => {
        const el = document.getElementById(id);
        el.addEventListener("input", refreshQualityUI);
        el.addEventListener("change", () => saveSettings());
    });

    // -----------------------------------------------------------------------
    // Settings — load on init, auto-save on change
    // -----------------------------------------------------------------------

    // The Advanced path fields (csv_path, images_dir, glb_path) are
    // deliberately not persisted: they're hidden by default, and a stale path
    // from a past run silently changing this run's behavior is worse than
    // retyping it. part_properties IS persisted — it's configuration the user
    // sets once (which custom properties their parts carry), not a stale-path
    // hazard.
    const settingsFields = [
        "assembly_path", "output_dir", "part_properties",
    ];

    function loadSettings() {
        fetch("/api/settings")
            .then(r => r.json())
            .then(data => {
                // Text fields
                settingsFields.forEach(id => {
                    const el = document.getElementById(id);
                    if (!el || data[id] === undefined) return;
                    el.value = data[id];
                });

                // Quality preset — set silently (no change event): the auto-save
                // listener must not fire before width/height/mode are applied,
                // or it would POST the DOM defaults over the stored values.
                if (data.quality) {
                    const radio = document.querySelector(`input[name="quality"][value="${data.quality}"]`);
                    if (radio) radio.checked = true;
                }
                // Custom width/height
                if (data.width) document.getElementById("width").value = data.width;
                if (data.height) document.getElementById("height").value = data.height;

                // Assembly mode
                if (data.assembly_mode) {
                    const radio = document.querySelector(`input[name="assembly_mode"][value="${data.assembly_mode}"]`);
                    if (radio) radio.checked = true;
                }

                // Output checkboxes
                if (data.output_excel !== undefined) {
                    document.getElementById("output_excel").checked = !!data.output_excel;
                }
                if (data.output_html !== undefined) {
                    document.getElementById("output_html").checked = !!data.output_html;
                }
                if (data.viewer_exports !== undefined) {
                    document.getElementById("viewer_exports").checked = !!data.viewer_exports;
                }
                if (data.keep_raw_glb !== undefined) {
                    document.getElementById("keep_raw_glb").checked = !!data.keep_raw_glb;
                }
                if (data.html_sidecar !== undefined) {
                    document.getElementById("html_sidecar").checked = !!data.html_sidecar;
                }
                if (data.viewer_up_axis) {
                    const stored = String(data.viewer_up_axis);
                    const radio = document.querySelector(
                        `input[name="viewer_up_axis"][value="${stored.slice(-1)}"]`);
                    if (radio) radio.checked = true;
                    document.getElementById("up_axis_flip").checked = stored[0] === "-";
                }
                refreshViewerExportsState();
                drawAxisPreview();

                // Update preview + chips + node states with loaded settings
                refreshQualityUI();
                refreshAssemblyField();
                settingsFields.forEach(id => showPathEnd(document.getElementById(id)));

                // Show time estimate from history
                showEstimate(data);
            })
            .catch(() => {});
    }

    function saveSettings() {
        const data = {};
        settingsFields.forEach(id => {
            const el = document.getElementById(id);
            if (el) data[id] = el.value;
        });

        const qualityRadio = getSelectedQuality();
        data.quality = qualityRadio ? qualityRadio.value : "standard";
        data.width = parseInt(document.getElementById("width").value, 10) || 1920;
        data.height = parseInt(document.getElementById("height").value, 10) || 1080;
        data.assembly_mode = getModeValue();
        const outputs = getOutputs();
        data.output_excel = outputs.excel;
        data.output_html = outputs.html;
        data.viewer_exports = outputs.viewerExports;
        data.keep_raw_glb = outputs.keepRawGlb;
        data.html_sidecar = outputs.htmlSidecar;
        data.viewer_up_axis = outputs.upAxis;

        postJson("/api/settings", data).catch(() => {});
    }

    // Auto-save settings when any input changes
    settingsFields.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("change", saveSettings);
    });
    document.querySelectorAll('input[name="quality"], input[name="assembly_mode"]').forEach(radio => {
        radio.addEventListener("change", saveSettings);
    });
    ["output_excel", "output_html", "viewer_exports", "keep_raw_glb", "html_sidecar",
     "up_axis_flip"].forEach(id => {
        document.getElementById(id).addEventListener("change", saveSettings);
    });
    document.querySelectorAll('input[name="viewer_up_axis"]').forEach(radio => {
        radio.addEventListener("change", saveSettings);
    });
    document.getElementById("output_html").addEventListener("change", refreshViewerExportsState);
    document.querySelectorAll('input[name="viewer_up_axis"], #up_axis_flip').forEach(el => {
        el.addEventListener("change", drawAxisPreview);
    });
    refreshViewerExportsState();
    drawAxisPreview();

    // -----------------------------------------------------------------------
    // Time estimation
    // -----------------------------------------------------------------------

    function formatDuration(totalSeconds) {
        totalSeconds = Math.round(totalSeconds);
        if (totalSeconds < 60) return totalSeconds + "s";
        var m = Math.floor(totalSeconds / 60);
        var s = totalSeconds % 60;
        if (m < 60) return m + "m " + (s > 0 ? s + "s" : "");
        var h = Math.floor(m / 60);
        var rm = m % 60;
        return h + "h " + (rm > 0 ? rm + "m" : "");
    }

    function showEstimate(settings) {
        if (!estimateInfo) return;
        var history = settings.timing_history;
        if (!history || !history.runs || history.runs.length === 0) {
            estimateInfo.textContent = "Time estimate appears after your first run.";
            preRunEstimate = null;
            return;
        }
        var runs = history.runs;
        var n = runs.length;
        var avgPerComp = runs.reduce(function (sum, r) { return sum + r.per_component_avg; }, 0) / n;
        var avgExcel = runs.reduce(function (sum, r) { return sum + r.excel_seconds; }, 0) / n;
        var lastComponents = runs[n - 1].components;
        var estimatedSec = 15 + (avgPerComp * lastComponents) + avgExcel;
        preRunEstimate = estimatedSec;

        var msg = "Estimated time: ~" + formatDuration(estimatedSec);
        msg += " (based on " + n + " previous run" + (n > 1 ? "s" : "");
        if (n < 3) msg += " — accuracy improves with each run";
        msg += ")";
        estimateInfo.textContent = msg;
    }

    function updateElapsedTime() {
        if (!runStartTime || !elapsedTimeEl) return;
        var elapsed = (Date.now() - runStartTime) / 1000;
        elapsedTimeEl.textContent = "Elapsed: " + formatDuration(elapsed);
    }

    function stopRunTimer() {
        clearInterval(elapsedInterval);
        elapsedInterval = null;
    }

    function refreshEstimate() {
        fetch("/api/settings")
            .then(function (r) { return r.json(); })
            .then(function (data) { showEstimate(data); })
            .catch(function () {});
    }

    // -----------------------------------------------------------------------
    // Browse buttons — open native file dialogs (they can appear behind
    // the browser window, so the button shows a pending state meanwhile)
    // -----------------------------------------------------------------------

    document.querySelectorAll(".btn-browse").forEach(btn => {
        btn.addEventListener("click", () => {
            const target = btn.dataset.target;
            const mode = btn.dataset.mode || "file";
            const originalText = btn.textContent;
            btn.disabled = true;
            btn.textContent = "Opening…";

            postJson("/api/browse", { mode })
                .then(r => r.json())
                .then(data => {
                    if (data.path) setFieldValue(document.getElementById(target), data.path);
                })
                .catch(err => console.error("Browse error:", err))
                .finally(() => {
                    btn.disabled = false;
                    btn.textContent = originalText;
                });
        });
    });

    // -----------------------------------------------------------------------
    // Open output folder
    // -----------------------------------------------------------------------

    if (openFolderBtn) {
        openFolderBtn.addEventListener("click", () => {
            fetch("/api/open-folder", { method: "POST" }).catch(() => {});
        });
    }

    // -----------------------------------------------------------------------
    // Collapse the setup steps into a summary strip during a run
    // -----------------------------------------------------------------------

    function basename(path) {
        return path.split(/[\\/]/).pop();
    }

    function postJson(url, body) {
        return fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    }

    // Set a field programmatically (Browse dialog, recent-BOM chip) and fire
    // the same events typing would, so every listener wired to the input
    // (validation, node states, auto-save) reacts identically.
    function setFieldValue(input, value) {
        input.value = value;
        input.dispatchEvent(new Event("input"));
        input.dispatchEvent(new Event("change"));
        showPathEnd(input);
    }

    // Long Windows paths overflow the inputs, and browsers snap the scroll
    // back to the start on blur — the least useful end of a file path. Keep
    // the tail (the filename) in view whenever the field isn't being edited.
    function showPathEnd(input) {
        if (input && document.activeElement !== input) {
            input.scrollLeft = input.scrollWidth;
        }
    }

    document.addEventListener("focusout", (e) => {
        const el = e.target;
        if (el && el.classList && el.classList.contains("input") && el.type === "text") {
            setTimeout(() => showPathEnd(el), 0);
        }
    });

    function populateStrip() {
        // Offline runs may leave the assembly blank — show the 3D model or
        // CSV that is actually driving the run instead
        const assemblyPath = assemblyInput.value.trim()
            || document.getElementById("glb_path").value.trim()
            || document.getElementById("csv_path").value.trim();
        const stripAssembly = document.getElementById("stripAssembly");
        stripAssembly.textContent = basename(assemblyPath);
        stripAssembly.title = assemblyPath;
        const outputDir = document.getElementById("output_dir").value.trim();
        document.getElementById("stripOutput").textContent = outputDir || "output folder";
        document.getElementById("stripQuality").textContent = qualityLabel();
        document.getElementById("stripMode").textContent = modeLabel();
        document.getElementById("stripOutputs").textContent = outputsLabel();
    }

    function collapseSetup() {
        populateStrip();
        setupSteps.classList.add("hidden");
        runSteps.classList.remove("hidden");
        summaryStep.classList.remove("hidden");
    }

    function restoreSetup() {
        setupSteps.classList.remove("hidden");
        summaryStep.classList.add("hidden");
    }

    document.getElementById("editSetupBtn").addEventListener("click", () => {
        restoreSetup();
        window.scrollTo({ top: 0, behavior: "smooth" });
    });

    // -----------------------------------------------------------------------
    // Form submit — start pipeline
    // -----------------------------------------------------------------------

    form.addEventListener("submit", (e) => {
        e.preventDefault();

        const assemblyPath = assemblyInput.value.trim();
        const csvPath = document.getElementById("csv_path").value.trim();
        const imagesDir = document.getElementById("images_dir").value.trim();
        const glbPath = document.getElementById("glb_path").value.trim();
        const outputs = getOutputs();

        // The Advanced inputs can replace SolidWorks entirely — only then may
        // the assembly file stay blank (it would just name the outputs).
        const offlineReady = csvPath && imagesDir && (glbPath || !outputs.html);
        if (!assemblyPath && !offlineReady) {
            showFieldMsg(assemblyMsg, "err",
                "Choose your assembly file first — click Browse to find the .sldasm. " +
                "(Or fill in every Advanced field to rebuild a BOM without SolidWorks.)");
            assemblyInput.focus();
            assemblyInput.scrollIntoView({ block: "center", behavior: "smooth" });
            return;
        }

        if (!outputs.excel && !outputs.html) {
            showFieldMsg(assemblyMsg, "err",
                "Pick at least one output in Export options (Excel or 3D interactive BOM).");
            document.getElementById("output_excel")
                .scrollIntoView({ block: "center", behavior: "smooth" });
            return;
        }

        // Reset UI
        runBtn.disabled = true;
        runBtn.textContent = "Running...";
        collapseSetup();
        setProgressNode("run");
        resultsSection.classList.add("hidden");
        gallerySection.classList.add("hidden");
        downloadLink.classList.add("hidden");
        downloadHtmlLink.classList.add("hidden");
        resultWarnings.classList.add("hidden");
        resultWarnings.innerHTML = "";
        if (openFolderBtn) openFolderBtn.classList.add("hidden");
        progressBar.style.width = "0%";
        progressText.textContent = "0%";
        progressCount.textContent = "";
        logEl.textContent = "";
        gallery.innerHTML = "";
        resultInfo.innerHTML = "";
        window.scrollTo({ top: 0, behavior: "smooth" });

        // Start timing
        if (estimateInfo) estimateInfo.textContent = "";
        componentTimes = [];
        lastRunSidecar = outputs.html && outputs.htmlSidecar;
        runStartTime = Date.now();
        if (timingInfo) timingInfo.classList.remove("hidden");
        if (elapsedTimeEl) elapsedTimeEl.textContent = "Elapsed: 0s";
        if (remainingTimeEl) remainingTimeEl.textContent = "";
        stopRunTimer();
        elapsedInterval = setInterval(updateElapsedTime, 1000);

        const wh = getWidthHeight();
        const params = {
            assembly_path: assemblyPath,
            output_dir: document.getElementById("output_dir").value.trim(),
            csv_path: csvPath,
            images_dir: imagesDir,
            glb_path: glbPath,
            width: wh.w,
            height: wh.h,
            bom_mode: getModeValue(),
            output_excel: outputs.excel,
            output_html: outputs.html,
            viewer_exports: outputs.viewerExports,
            keep_raw_glb: outputs.keepRawGlb,
            html_sidecar: outputs.htmlSidecar,
            viewer_up_axis: outputs.upAxis,
            part_properties: document.getElementById("part_properties").value.trim(),
        };

        postJson("/api/run", params)
            .then(r => r.json())
            .then(data => {
                if (data.error) {
                    failRunStart(data.error);
                    return;
                }
                jobRunning = true;
                listenProgress();
            })
            .catch(err => {
                failRunStart(err.message);
            });
    });

    // The run never started — undo everything the submit handler set up
    function failRunStart(message) {
        stopRunTimer();
        runStartTime = null;
        resetBtn();
        restoreSetup();
        runSteps.classList.add("hidden");
        showFieldMsg(assemblyMsg, "err", "Couldn't start the run: " + message);
    }

    // -----------------------------------------------------------------------
    // SSE — listen for progress events
    // -----------------------------------------------------------------------

    function listenProgress() {
        const source = new EventSource("/api/progress");

        source.onmessage = (e) => {
            const event = JSON.parse(e.data);

            if (event.type === "heartbeat") return;

            if (event.type === "status") {
                appendLog(event.message);
                // Post-capture stages have no per-part progress — surface the
                // current stage where the countdown used to be.
                const STAGE_LABELS = [
                    ["Generating Excel", "Generating Excel..."],
                    ["Exporting 3D model", "Exporting 3D model (may take a few minutes)..."],
                    ["Optimizing 3D model", "Optimizing 3D model..."],
                    ["Preparing thumbnails", "Preparing thumbnails..."],
                    ["Writing interactive 3D BOM", "Writing 3D BOM file..."],
                ];
                if (remainingTimeEl) {
                    const stage = STAGE_LABELS.find(s => event.message.indexOf(s[0]) === 0);
                    if (stage) remainingTimeEl.textContent = stage[1];
                }
            }

            if (event.type === "progress") {
                const pct = Math.round((event.current / event.total) * 100);
                progressBar.style.width = pct + "%";
                progressText.textContent = pct + "%";
                progressCount.textContent = event.current + " of " + event.total + " parts";

                const status = event.success ? "" : "  WARNING: Failed";
                appendLog(`[${event.current}/${event.total}] Capturing ${event.part_name}...${status}`);

                // Track per-component timing for ETA
                if (event.elapsed_seconds > 0) {
                    componentTimes.push(event.elapsed_seconds);
                }
                if (remainingTimeEl && componentTimes.length >= 2) {
                    var avg = componentTimes.reduce(function (a, b) { return a + b; }, 0) / componentTimes.length;
                    var remaining = event.total - event.current;
                    var remainingSec = remaining * avg;
                    remainingTimeEl.textContent = "Remaining: ~" + formatDuration(remainingSec);
                }

                // Add thumbnail to gallery (newest first)
                if (event.success && event.image) {
                    gallerySection.classList.remove("hidden");
                    const item = document.createElement("div");
                    item.className = "gallery-item";
                    const img = document.createElement("img");
                    img.src = "/api/images/" + encodeURIComponent(event.image);
                    img.alt = event.part_name;
                    const name = document.createElement("div");
                    name.className = "name";
                    name.title = event.part_name;
                    name.textContent = event.part_name;
                    item.append(img, name);
                    gallery.prepend(item);
                }
            }

            if (event.type === "done") {
                source.close();
                jobRunning = false;
                resetBtn();
                setProgressNode("complete");

                // Stop timing and show final elapsed
                stopRunTimer();
                if (runStartTime) {
                    var totalElapsed = (Date.now() - runStartTime) / 1000;
                    var completedMsg = "Completed in " + formatDuration(totalElapsed);
                    if (preRunEstimate) {
                        completedMsg += " (estimated " + formatDuration(preRunEstimate) + ")";
                    }
                    if (elapsedTimeEl) elapsedTimeEl.textContent = completedMsg;
                    if (remainingTimeEl) remainingTimeEl.textContent = "";
                    runStartTime = null;
                }

                const r = event.result;
                resultsSection.classList.remove("hidden");
                let resLine =
                    `Components: ${r.total_components} &mdash; Images captured: ${r.captured_count}`;
                if (r.html_path && r.html_projected_mb) {
                    resLine += ` &mdash; 3D BOM: ${r.html_projected_mb} MB`;
                }
                resultInfo.innerHTML = resLine;

                if (openFolderBtn) openFolderBtn.classList.remove("hidden");
                if (r.excel_path) {
                    var excelName = basename(r.excel_path);
                    downloadLink.classList.remove("hidden");
                    downloadLink.href = "/api/download/" + encodeURIComponent(excelName);
                }
                if (r.html_path) {
                    downloadHtmlLink.classList.remove("hidden");
                    downloadHtmlLink.href = "/api/download/" +
                        encodeURIComponent(basename(r.html_path));
                }
                if (r.excel_path || r.html_path) {
                    appendLog("\nDone! BOM generated successfully.");
                } else {
                    appendLog("\nDone! No BOM data to write.");
                }
                if (r.bom_csv_path) {
                    // Not auto-filled into the Advanced field on purpose — a
                    // path the user didn't type must never silently change the
                    // next run.
                    appendLog("Parts list also saved as " + basename(r.bom_csv_path) +
                        " — put it (or the .xlsx) in Advanced > Existing BOM to rerun " +
                        "without SolidWorks.");
                }

                const warnings = (r.warnings || []).slice();
                if (r.html_mode === "sidecar" && r.sidecar_path) {
                    const reason = lastRunSidecar
                        ? "The 3D data was written as a separate file (as requested): "
                        : "The 3D BOM was too large for a single file, so it was split: ";
                    warnings.unshift(reason +
                        "keep the .html and " + basename(r.sidecar_path) +
                        " together — the page asks for the .glb when opened.");
                }
                if (warnings.length) {
                    resultWarnings.classList.remove("hidden");
                    resultWarnings.innerHTML = warnings
                        .map(w => `<div class="result-warning">${escapeHtml(w)}</div>`)
                        .join("");
                    warnings.forEach(w => appendLog("WARNING: " + w));
                }

                // Refresh estimate for next run with updated history
                refreshEstimate();

                // Refresh recent BOMs chips (new BOM was generated)
                loadRecentBoms();
            }

            if (event.type === "error") {
                source.close();
                jobRunning = false;
                resetBtn();
                restoreSetup();
                setProgressNode("error");

                // Stop timing
                stopRunTimer();
                if (runStartTime) {
                    var errorElapsed = (Date.now() - runStartTime) / 1000;
                    if (elapsedTimeEl) elapsedTimeEl.textContent = "Failed after " + formatDuration(errorElapsed);
                    if (remainingTimeEl) remainingTimeEl.textContent = "";
                    runStartTime = null;
                }

                appendLog("\nERROR: " + event.message);
                resultInfo.innerHTML = `<span class="error">${escapeHtml(event.message)}</span>`;
                resultsSection.classList.remove("hidden");
            }
        };

        source.onerror = () => {
            // Transient drops (sleep/wake, brief network blips) leave readyState
            // at CONNECTING and the browser reconnects on its own — the backend
            // job keeps running and its queued events resume flowing. Only a
            // permanently closed stream needs UI recovery.
            if (source.readyState !== EventSource.CLOSED) return;
            stopRunTimer();
            setProgressNode("error");
            resetBtn();
            restoreSetup();
            appendLog("\nLost the connection to the local pictureBOM server — the job may still be running. Reload this page to reconnect.");
            // jobRunning stays true: the server-side job may still be working,
            // so keep the tab-close warning until we know otherwise.
        };
    }

    // -----------------------------------------------------------------------
    // Quit button
    // -----------------------------------------------------------------------

    const quitBtn = document.getElementById("quitBtn");
    if (quitBtn) {
        quitBtn.addEventListener("click", () => {
            if (!confirm("Shut down pictureBOM? This will stop the server.")) return;
            jobRunning = false;
            fetch("/api/quit", { method: "POST" }).catch(() => {});
            document.body.innerHTML = '<div class="shutdown-message">' +
                '<h2>pictureBOM has been shut down.</h2>' +
                '<p>You can close this tab.</p></div>';
        });
    }

    // -----------------------------------------------------------------------
    // Warn on tab close — only while a job is running
    // -----------------------------------------------------------------------

    window.addEventListener("beforeunload", function (e) {
        if (!jobRunning) return;
        e.preventDefault();
    });

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    function appendLog(text) {
        logEl.textContent += text + "\n";
        logEl.scrollTop = logEl.scrollHeight;
    }

    function resetBtn() {
        runBtn.disabled = false;
        runBtn.textContent = "Run pictureBOM";
    }

    function escapeHtml(str) {
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    // -----------------------------------------------------------------------
    // Compare BOMs
    // -----------------------------------------------------------------------

    const compareBtn = document.getElementById("compareBtn");
    const compareError = document.getElementById("compareError");
    const compareResults = document.getElementById("compareResults");
    const compareSummary = document.getElementById("compareSummary");
    const compareBody = document.getElementById("compareBody");
    const compareDownload = document.getElementById("compareDownload");
    const cmpNode1 = document.getElementById("cmpNode1");
    const cmpNode2 = document.getElementById("cmpNode2");
    const bomAInput = document.getElementById("bom_a");
    const bomBInput = document.getElementById("bom_b");

    function updateCompareNodes() {
        setNodeDone(cmpNode1, bomAInput.value.trim() !== "", "1");
        setNodeDone(cmpNode2, bomBInput.value.trim() !== "", "2");
    }

    [bomAInput, bomBInput].forEach(input => {
        input.addEventListener("input", () => {
            updateCompareNodes();
            hideFieldMsg(compareError);
        });
    });

    function renderRecentChips(containerId, inputEl, boms) {
        const container = document.getElementById(containerId);
        container.innerHTML = "";
        const label = document.createElement("span");
        label.className = "recent-label";
        label.textContent = "Recent:";
        container.appendChild(label);

        if (!boms.length) {
            const empty = document.createElement("span");
            empty.className = "recent-empty";
            empty.textContent = "No BOMs yet — run pictureBOM once and they'll show up here.";
            container.appendChild(empty);
            return;
        }

        boms.slice(0, 5).forEach(b => {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "fchip";
            chip.textContent = b.name;
            chip.title = b.path;
            chip.addEventListener("click", () => setFieldValue(inputEl, b.path));
            container.appendChild(chip);
        });
    }

    function loadRecentBoms() {
        fetch("/api/recent-boms")
            .then(function (r) { return r.json(); })
            .then(function (boms) {
                renderRecentChips("recentA", bomAInput, boms);
                renderRecentChips("recentB", bomBInput, boms);
            })
            .catch(function () {});
    }

    if (compareBtn) {
        compareBtn.addEventListener("click", function () {
            var bomA = bomAInput.value.trim();
            var bomB = bomBInput.value.trim();
            if (!bomA || !bomB) {
                showFieldMsg(compareError, "err",
                    "Pick both BOMs to compare — the one you have, and the one you want to build.");
                return;
            }

            hideFieldMsg(compareError);
            compareBtn.disabled = true;
            compareBtn.textContent = "Comparing...";
            compareResults.classList.add("hidden");

            postJson("/api/compare", { bom_a: bomA, bom_b: bomB })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.error) {
                        showFieldMsg(compareError, "err", data.error);
                        return;
                    }
                    showCompareResults(data);
                })
                .catch(function (err) {
                    showFieldMsg(compareError, "err", "Compare failed: " + err.message);
                })
                .finally(function () {
                    compareBtn.disabled = false;
                    compareBtn.textContent = "Show what I need to order";
                });
        });
    }

    function showCompareResults(data) {
        compareResults.classList.remove("hidden");

        var s = data.summary;
        if (s.shortage_count === 0) {
            compareSummary.classList.add("ok");
            compareSummary.innerHTML =
                "All <strong>" + s.total_in_b + "</strong> part(s) in " +
                "<strong>" + escapeHtml(data.bom_b) + "</strong> are already covered " +
                "by what you have. Nothing to order!";
        } else {
            compareSummary.classList.remove("ok");
            compareSummary.innerHTML =
                "You need to order <strong>" + s.shortage_count + "</strong> part(s). " +
                "<strong>" + s.fully_covered + "</strong> of <strong>" + s.total_in_b +
                "</strong> part(s) are already covered by what you have.";
        }

        // Build table rows
        compareBody.innerHTML = "";
        data.rows.forEach(function (row) {
            var tr = document.createElement("tr");

            // Image cell
            var tdImg = document.createElement("td");
            if (row.image) {
                var img = document.createElement("img");
                img.src = "/api/compare/images/" + encodeURIComponent(row.image);
                img.alt = row.part_number;
                tdImg.appendChild(img);
            }
            tr.appendChild(tdImg);

            // Part number
            var tdPN = document.createElement("td");
            tdPN.textContent = row.part_number;
            tdPN.className = "part";
            tr.appendChild(tdPN);

            // Description
            var tdDesc = document.createElement("td");
            tdDesc.textContent = row.description;
            tr.appendChild(tdDesc);

            // Already Have
            var tdA = document.createElement("td");
            tdA.textContent = row.qty_a;
            tdA.className = "num";
            tr.appendChild(tdA);

            // Need
            var tdB = document.createElement("td");
            tdB.textContent = row.qty_b;
            tdB.className = "num";
            tr.appendChild(tdB);

            // To Order
            var tdShortage = document.createElement("td");
            tdShortage.textContent = row.shortage;
            tdShortage.className = "num num-order";
            tr.appendChild(tdShortage);

            // Color code row
            tr.className = row.qty_a === 0 ? "compare-missing" : "compare-shortage";
            compareBody.appendChild(tr);
        });

        // Download link
        if (data.excel_filename) {
            compareDownload.href = "/api/compare/download/" + encodeURIComponent(data.excel_filename);
            compareDownload.classList.remove("hidden");
        }

        compareResults.scrollIntoView({ behavior: "smooth", block: "nearest" });

        // Refresh recent BOMs list (new comparison file was created)
        loadRecentBoms();
    }

    // -----------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------

    updateReady();
    refreshAssemblyField();
    refreshQualityUI();
    loadSettings();
    loadRecentBoms();
    updateCompareNodes();
})();
