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

    const settingsFields = [
        "assembly_path", "output_dir", "csv_path", "images_dir",
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
        const assemblyPath = assemblyInput.value.trim();
        const stripAssembly = document.getElementById("stripAssembly");
        stripAssembly.textContent = basename(assemblyPath);
        stripAssembly.title = assemblyPath;
        const outputDir = document.getElementById("output_dir").value.trim();
        document.getElementById("stripOutput").textContent = outputDir || "output folder";
        document.getElementById("stripQuality").textContent = qualityLabel();
        document.getElementById("stripMode").textContent = modeLabel();
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
        if (!assemblyPath) {
            showFieldMsg(assemblyMsg, "err",
                "Choose your assembly file first — click Browse to find the .sldasm.");
            assemblyInput.focus();
            assemblyInput.scrollIntoView({ block: "center", behavior: "smooth" });
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
            csv_path: document.getElementById("csv_path").value.trim(),
            images_dir: document.getElementById("images_dir").value.trim(),
            width: wh.w,
            height: wh.h,
            bom_mode: getModeValue(),
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
                if (remainingTimeEl && event.message.indexOf("Generating Excel") === 0) {
                    remainingTimeEl.textContent = "Generating Excel...";
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
                resultInfo.innerHTML =
                    `Components: ${r.total_components} &mdash; Images captured: ${r.captured_count}`;

                if (openFolderBtn) openFolderBtn.classList.remove("hidden");
                if (r.excel_path) {
                    var excelName = basename(r.excel_path);
                    downloadLink.classList.remove("hidden");
                    downloadLink.href = "/api/download/" + encodeURIComponent(excelName);
                    appendLog("\nDone! BOM generated successfully.");
                } else {
                    appendLog("\nDone! No BOM data to write.");
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
