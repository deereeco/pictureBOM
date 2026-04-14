// pictureBOM GUI — vanilla JS

(function () {
    const form = document.getElementById("bomForm");
    const runBtn = document.getElementById("runBtn");
    const progressSection = document.getElementById("progressSection");
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");
    const logEl = document.getElementById("log");
    const resultsSection = document.getElementById("resultsSection");
    const resultInfo = document.getElementById("resultInfo");
    const downloadLink = document.getElementById("downloadLink");
    const gallerySection = document.getElementById("gallerySection");
    const gallery = document.getElementById("gallery");
    const settingsPanel = document.getElementById("settingsPanel");
    const previewBox = document.getElementById("previewBox");
    const previewLabel = document.getElementById("previewLabel");
    const customSizeEl = document.getElementById("customSize");

    // -----------------------------------------------------------------------
    // Quality presets + preview box
    // -----------------------------------------------------------------------

    // Max resolution maps to the full preview container size (140x100)
    const MAX_W = 3840;
    const MAX_H = 2160;
    const BOX_MAX_W = 130;
    const BOX_MAX_H = 90;

    function updatePreview(w, h) {
        const scaleW = (w / MAX_W) * BOX_MAX_W;
        const scaleH = (h / MAX_H) * BOX_MAX_H;
        previewBox.style.width = Math.max(20, Math.round(scaleW)) + "px";
        previewBox.style.height = Math.max(14, Math.round(scaleH)) + "px";
        previewLabel.innerHTML = w + " &times; " + h;
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

    document.querySelectorAll('input[name="quality"]').forEach(radio => {
        radio.addEventListener("change", () => {
            if (radio.value === "custom") {
                customSizeEl.classList.remove("hidden");
                const wh = getWidthHeight();
                updatePreview(wh.w, wh.h);
            } else {
                customSizeEl.classList.add("hidden");
                updatePreview(parseInt(radio.dataset.w, 10), parseInt(radio.dataset.h, 10));
            }
        });
    });

    // Update preview when custom inputs change
    document.getElementById("width").addEventListener("input", () => {
        const wh = getWidthHeight();
        updatePreview(wh.w, wh.h);
    });
    document.getElementById("height").addEventListener("input", () => {
        const wh = getWidthHeight();
        updatePreview(wh.w, wh.h);
    });

    // Initialize preview
    updatePreview(1920, 1080);

    // -----------------------------------------------------------------------
    // Settings — load on init, save after successful run
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

                // Quality preset
                if (data.quality) {
                    const radio = document.querySelector(`input[name="quality"][value="${data.quality}"]`);
                    if (radio) {
                        radio.checked = true;
                        radio.dispatchEvent(new Event("change"));
                    }
                }
                // Custom width/height
                if (data.width) document.getElementById("width").value = data.width;
                if (data.height) document.getElementById("height").value = data.height;

                // Assembly mode
                if (data.assembly_mode) {
                    const radio = document.querySelector(`input[name="assembly_mode"][value="${data.assembly_mode}"]`);
                    if (radio) radio.checked = true;
                }

                // Update preview with loaded settings
                const wh = getWidthHeight();
                updatePreview(wh.w, wh.h);
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

        const modeRadio = document.querySelector('input[name="assembly_mode"]:checked');
        data.assembly_mode = modeRadio ? modeRadio.value : "flat";

        fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data),
        }).catch(() => {});
    }

    loadSettings();

    // -----------------------------------------------------------------------
    // Browse buttons — open native file dialogs
    // -----------------------------------------------------------------------

    document.querySelectorAll(".btn-browse").forEach(btn => {
        btn.addEventListener("click", () => {
            const target = btn.dataset.target;
            const mode = btn.dataset.mode || "file";

            fetch("/api/browse", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ mode }),
            })
                .then(r => r.json())
                .then(data => {
                    if (data.path) {
                        document.getElementById(target).value = data.path;
                    }
                })
                .catch(err => console.error("Browse error:", err));
        });
    });

    // -----------------------------------------------------------------------
    // Form submit — start pipeline
    // -----------------------------------------------------------------------

    form.addEventListener("submit", (e) => {
        e.preventDefault();

        const assemblyPath = document.getElementById("assembly_path").value.trim();
        if (!assemblyPath) return;

        // Reset UI
        runBtn.disabled = true;
        runBtn.textContent = "Running...";
        settingsPanel.removeAttribute("open");
        progressSection.classList.remove("hidden");
        resultsSection.classList.add("hidden");
        gallerySection.classList.add("hidden");
        downloadLink.classList.add("hidden");
        progressBar.style.width = "0%";
        progressText.textContent = "0%";
        logEl.textContent = "";
        gallery.innerHTML = "";
        resultInfo.innerHTML = "";

        const wh = getWidthHeight();
        const modeRadio = document.querySelector('input[name="assembly_mode"]:checked');

        const params = {
            assembly_path: assemblyPath,
            output_dir: document.getElementById("output_dir").value.trim() || "./output",
            csv_path: document.getElementById("csv_path").value.trim(),
            images_dir: document.getElementById("images_dir").value.trim(),
            width: wh.w,
            height: wh.h,
            bom_mode: modeRadio ? modeRadio.value : "flat",
        };

        fetch("/api/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
        })
            .then(r => r.json())
            .then(data => {
                if (data.error) {
                    appendLog("ERROR: " + data.error);
                    resetBtn();
                    return;
                }
                listenProgress();
            })
            .catch(err => {
                appendLog("ERROR: " + err.message);
                resetBtn();
            });
    });

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
            }

            if (event.type === "progress") {
                const pct = Math.round((event.current / event.total) * 100);
                progressBar.style.width = pct + "%";
                progressText.textContent = pct + "%";

                const status = event.success ? "" : "  WARNING: Failed";
                appendLog(`[${event.current}/${event.total}] Capturing ${event.part_name}...${status}`);

                // Add thumbnail to gallery (newest first)
                if (event.success && event.image) {
                    gallerySection.classList.remove("hidden");
                    const item = document.createElement("div");
                    item.className = "gallery-item";
                    item.innerHTML =
                        `<img src="/api/images/${encodeURIComponent(event.image)}" alt="${escapeHtml(event.part_name)}">` +
                        `<div class="name" title="${escapeHtml(event.part_name)}">${escapeHtml(event.part_name)}</div>`;
                    gallery.prepend(item);
                }
            }

            if (event.type === "done") {
                source.close();
                resetBtn();
                settingsPanel.setAttribute("open", "");
                saveSettings();

                const r = event.result;
                resultsSection.classList.remove("hidden");
                resultInfo.innerHTML =
                    `Components: ${r.total_components} &mdash; Images captured: ${r.captured_count}`;

                if (r.excel_path) {
                    downloadLink.classList.remove("hidden");
                    downloadLink.href = "/api/download/bom.xlsx";
                    appendLog("\nDone! BOM generated successfully.");
                } else {
                    appendLog("\nDone! No BOM data to write.");
                }
            }

            if (event.type === "error") {
                source.close();
                resetBtn();
                settingsPanel.setAttribute("open", "");
                appendLog("\nERROR: " + event.message);
                resultInfo.innerHTML = `<span class="error">${escapeHtml(event.message)}</span>`;
                resultsSection.classList.remove("hidden");
            }
        };

        source.onerror = () => {
            source.close();
            resetBtn();
        };
    }

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
})();
