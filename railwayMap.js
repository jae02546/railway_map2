async function main() {
  const JAPAN_BOUNDS = [[122.5, 23.5], [154.5, 46.2]];
  const tree = document.getElementById("railwayTree");
  const searchInput = document.getElementById("searchInput");
  const selectionText = document.getElementById("selectionText");
  const mobileSelection = document.getElementById("mobileSelection");
  const loading = document.getElementById("loading");
  const companyAutoZoom = document.getElementById("companyAutoZoom");
  const companyAutoZoomKey = "railwayMap.companyAutoZoom";

  companyAutoZoom.checked = readBooleanSetting(companyAutoZoomKey, true);

  let geoLineJson;
  let geoStaJson;
  let railwayOrder;
  let companyLines = new Map();
  let stations = [];
  let selectedCompany = null;
  let selectedLine = null;
  let popup;
  let isMapDragging = false;

  try {
    [geoLineJson, geoStaJson, railwayOrder] = await Promise.all([
      fetchJson("N02-21_RailroadSection.geojson"),
      fetchJson("N02-21_Station.geojson"),
      fetchJson("railway-order.json")
    ]);
  } catch (error) {
    loading.querySelector(".loading-card").textContent = "データを読み込めませんでした。HTTPサーバーから開いてください。";
    console.error(error);
    return;
  }

  buildIndex();

  const map = new maplibregl.Map({
    container: "divSvg",
    style: "https://tiles.openfreemap.org/styles/positron",
    bounds: JAPAN_BOUNDS,
    fitBoundsOptions: { padding: 28 },
    maxZoom: 17,
    minZoom: 3,
    maxBounds: [[121.5, 20], [155.5, 47]],
    attributionControl: { compact: true }
  });

  map.on("load", async () => {
    removeBoundaryLayers();
    addRailwayLayers();
    bindMapInteractions();
    await restoreFromUrl();
    renderTree("");
    loading.classList.add("hidden");
  });

  map.on("error", event => {
    if (event.error) console.error("MapLibre:", event.error);
  });

  map.on("dragstart", () => {
    isMapDragging = true;
    hidePopup();
    map.getCanvas().style.cursor = "default";
    map.getCanvasContainer().style.cursor = "default";
  });

  map.on("dragend", () => {
    isMapDragging = false;
    map.getCanvas().style.cursor = "default";
    map.getCanvasContainer().style.cursor = "default";
  });

  function addRailwayLayers() {
    map.addSource("railways", { type: "geojson", data: geoLineJson, generateId: true });
    map.addSource("stations", { type: "geojson", data: geoStaJson, generateId: true });

    map.addLayer({
      id: "railways-base",
      type: "line",
      source: "railways",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": "#606966",
        "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.7, 8, 1.3, 13, 2.2],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 4, 0.58, 9, 0.78]
      }
    });
    map.addLayer({
      id: "railways-company",
      type: "line",
      source: "railways",
      filter: ["==", ["get", "N02_004"], "__none__"],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#2f67c7", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1.7, 10, 3.5], "line-opacity": 0.95 }
    });
    map.addLayer({
      id: "railways-selected",
      type: "line",
      source: "railways",
      filter: ["all", ["==", ["get", "N02_004"], "__none__"], ["==", ["get", "N02_003"], "__none__"]],
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#dc3f3f", "line-width": ["interpolate", ["linear"], ["zoom"], 4, 2.6, 10, 5], "line-opacity": 1 }
    });
    map.addLayer({
      id: "stations-base",
      type: "line",
      source: "stations",
      minzoom: 10,
      layout: { "line-cap": "round" },
      paint: { "line-color": "#18201c", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 5], "line-opacity": 0.9 }
    });
    map.addLayer({
      id: "stations-selected",
      type: "line",
      source: "stations",
      minzoom: 9,
      filter: ["all", ["==", ["get", "N02_004"], "__none__"], ["==", ["get", "N02_003"], "__none__"]],
      layout: { "line-cap": "round" },
      paint: { "line-color": "#fff", "line-width": ["interpolate", ["linear"], ["zoom"], 9, 3, 15, 7], "line-opacity": 1 }
    });
  }

  function removeBoundaryLayers() {
    const layers = map.getStyle().layers || [];
    for (const layer of layers) {
      const sourceLayer = layer["source-layer"] || "";
      if (/boundary|admin[_-]?border|maritime/i.test(`${layer.id} ${sourceLayer}`)) {
        map.removeLayer(layer.id);
      }
    }
  }

  function bindMapInteractions() {
    const interactiveLayers = ["railways-selected", "railways-company", "railways-base"];
    for (const layer of interactiveLayers) {
      map.on("mouseenter", layer, showRoutePopup);
      map.on("mouseleave", layer, hidePopup);
    }
    map.on("mouseenter", "stations-base", showStationPopup);
    map.on("mouseleave", "stations-base", hidePopup);
    map.on("click", event => {
      const features = map.queryRenderedFeatures(event.point, {
        layers: ["stations-base", "railways-selected", "railways-company", "railways-base"]
      });
      const feature = features[0];
      if (!feature) return;
      selectRouteByInteraction(feature.properties.N02_004, feature.properties.N02_003, true);
    });
  }

  function showRoutePopup(event) {
    if (isMapDragging) return;
    const feature = event.features && event.features[0];
    if (!feature) return;
    showPopup(event.lngLat, `<strong>${escapeHtml(feature.properties.N02_003)}</strong><br><span>${escapeHtml(feature.properties.N02_004)}</span>`);
  }

  function showStationPopup(event) {
    if (isMapDragging) return;
    const feature = event.features && event.features[0];
    if (!feature) return;
    showPopup(event.lngLat, `<strong>${escapeHtml(feature.properties.N02_005)}</strong><br><span>${escapeHtml(feature.properties.N02_003)}</span>`);
  }

  function showPopup(lngLat, html) {
    if (popup) popup.remove();
    popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 }).setLngLat(lngLat).setHTML(html).addTo(map);
  }

  function hidePopup() {
    map.getCanvas().style.cursor = "default";
    if (popup) popup.remove();
    popup = null;
  }

  function buildIndex() {
    for (const feature of geoLineJson.features) {
      const company = feature.properties.N02_004;
      const line = feature.properties.N02_003;
      if (!companyLines.has(company)) companyLines.set(company, new Set());
      companyLines.get(company).add(line);
    }
    const seen = new Set();
    for (const feature of geoStaJson.features) {
      const { N02_004: company, N02_003: line, N02_005: name } = feature.properties;
      const key = `${company}_${line}_${name}`;
      if (name && !seen.has(key)) {
        seen.add(key);
        stations.push({ company, line, name, geometry: feature.geometry });
      }
    }
    const discovered = companyLines;
    const ordered = new Map();
    const configuredCompanies = Array.isArray(railwayOrder.companies) ? railwayOrder.companies : [];

    for (const entry of configuredCompanies) {
      if (!entry || typeof entry.name !== "string" || !discovered.has(entry.name) || ordered.has(entry.name)) continue;
      const availableLines = discovered.get(entry.name);
      const orderedLines = new Set();
      for (const line of Array.isArray(entry.lines) ? entry.lines : []) {
        if (availableLines.has(line)) orderedLines.add(line);
      }
      const missingLines = [...availableLines]
        .filter(line => !orderedLines.has(line))
        .sort((a, b) => a.localeCompare(b, "ja"));
      for (const line of missingLines) orderedLines.add(line);
      ordered.set(entry.name, orderedLines);
    }

    const missingCompanies = [...discovered.keys()]
      .filter(company => !ordered.has(company))
      .sort((a, b) => a.localeCompare(b, "ja"));
    for (const company of missingCompanies) {
      ordered.set(company, new Set([...discovered.get(company)].sort((a, b) => a.localeCompare(b, "ja"))));
    }
    companyLines = ordered;
  }

  function renderTree(query) {
    const q = query.trim().toLocaleLowerCase("ja");
    const stationMatches = q ? stations.filter(s => s.name.toLocaleLowerCase("ja").includes(q)).slice(0, 20) : [];
    const rows = [];
    for (const [company, lineSet] of companyLines) {
      const allLines = [...lineSet];
      const companyMatch = company.toLocaleLowerCase("ja").includes(q);
      const visibleLines = q && !companyMatch ? allLines.filter(line => line.toLocaleLowerCase("ja").includes(q)) : allLines;
      if (q && !companyMatch && visibleLines.length === 0) continue;
      rows.push({ company, lines: visibleLines, open: Boolean(q) || company === selectedCompany });
    }
    document.getElementById("companyCount").textContent = `${rows.length} 社`;
    const companiesHtml = rows.map(({ company, lines, open }) => `
      <section class="company ${open ? "open" : ""} ${company === selectedCompany ? "active" : ""}" data-company="${escapeHtml(company)}">
        <button class="company-toggle" aria-expanded="${open}">
          <span class="chevron">›</span><span class="company-name">${highlight(company, q)}</span><span class="line-count">${lines.length}</span>
        </button>
        <div class="lines">${lines.map(line => `<button class="line-button ${company === selectedCompany && line === selectedLine ? "active" : ""}" data-line="${escapeHtml(line)}">${highlight(line, q)}</button>`).join("")}</div>
      </section>`).join("");
    const stationHtml = stationMatches.length ? `<div class="list-head"><span>駅の検索結果</span><span>${stationMatches.length}件</span></div>${stationMatches.map((s, i) => `<button class="line-button station-result" data-station-index="${stations.indexOf(s)}"><strong>${highlight(s.name, q)}</strong><br><small>${escapeHtml(s.company)} · ${escapeHtml(s.line)}</small></button>`).join("")}` : "";
    tree.innerHTML = stationHtml + companiesHtml || `<div class="empty">一致する事業者・路線・駅が<br>見つかりませんでした。</div>`;
  }

  tree.addEventListener("click", async event => {
    const stationButton = event.target.closest(".station-result");
    if (stationButton) {
      const station = stations[Number(stationButton.dataset.stationIndex)];
      selectRoute(station.company, station.line, false);
      const bounds = getGeometryBounds(station.geometry);
      map.fitBounds(bounds, { padding: 110, maxZoom: 14, duration: 750 });
      closeSidebar();
      return;
    }
    const lineButton = event.target.closest(".line-button");
    if (lineButton) {
      const company = lineButton.closest(".company").dataset.company;
      selectRouteByInteraction(company, lineButton.dataset.line, false);
      closeSidebar();
      return;
    }
    const toggle = event.target.closest(".company-toggle");
    if (toggle) {
      const section = toggle.closest(".company");
      const shouldOpen = !section.classList.contains("open");
      section.classList.toggle("open", shouldOpen);
      toggle.setAttribute("aria-expanded", shouldOpen);
      if (shouldOpen) selectCompany(section.dataset.company, companyAutoZoom.checked);
    }
  });

  function selectCompany(company, fit) {
    selectedCompany = company;
    selectedLine = null;
    updateLayerFilters();
    if (fit) fitFeatures(company, null);
    finishSelectionChange();
  }

  function selectRoute(company, line, fit, revealInList = false) {
    selectedCompany = company;
    selectedLine = line;
    updateLayerFilters();
    if (fit) fitFeatures(company, line);
    finishSelectionChange(revealInList);
  }

  function selectRouteByInteraction(company, line, revealInList) {
    const isSameRoute = selectedCompany === company && selectedLine === line;
    selectRoute(company, line, isSameRoute, revealInList);
  }

  function updateLayerFilters() {
    const company = selectedCompany || "__none__";
    const line = selectedLine || "__none__";
    map.setFilter("railways-company", ["==", ["get", "N02_004"], company]);
    map.setFilter("railways-selected", ["all", ["==", ["get", "N02_004"], company], ["==", ["get", "N02_003"], line]]);
    map.setFilter("stations-selected", ["all", ["==", ["get", "N02_004"], company], ["==", ["get", "N02_003"], line]]);
  }

  function fitFeatures(company, line) {
    const features = geoLineJson.features.filter(feature => feature.properties.N02_004 === company && (!line || feature.properties.N02_003 === line));
    const bounds = new maplibregl.LngLatBounds();
    for (const feature of features) extendBounds(bounds, feature.geometry.coordinates);
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: window.innerWidth < 760 ? 62 : 80, maxZoom: line ? 13 : 10, duration: 750 });
  }

  function showHome() {
    selectedCompany = null;
    selectedLine = null;
    updateLayerFilters();
    map.fitBounds(JAPAN_BOUNDS, { padding: 28, duration: 750 });
    finishSelectionChange();
  }

  function finishSelectionChange(revealInList = false) {
    updateSelection();
    if (revealInList) searchInput.value = "";
    renderTree(searchInput.value);
    if (revealInList) {
      requestAnimationFrame(() => {
        const selected = tree.querySelector(".line-button.active");
        if (selected) selected.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
    saveToUrl();
  }

  document.getElementById("zoomIn").addEventListener("click", () => map.zoomIn({ duration: 280 }));
  document.getElementById("zoomOut").addEventListener("click", () => map.zoomOut({ duration: 280 }));
  document.getElementById("homeView").addEventListener("click", showHome);
  document.getElementById("resetSelection").addEventListener("click", showHome);
  searchInput.addEventListener("input", () => renderTree(searchInput.value));
  document.getElementById("clearSearch").addEventListener("click", () => { searchInput.value = ""; renderTree(""); searchInput.focus(); });
  document.getElementById("sidebarOpen").addEventListener("click", () => document.body.classList.add("sidebar-open"));
  document.getElementById("sidebarClose").addEventListener("click", closeSidebar);
  document.getElementById("backdrop").addEventListener("click", closeSidebar);
  companyAutoZoom.addEventListener("change", () => {
    writeBooleanSetting(companyAutoZoomKey, companyAutoZoom.checked);
  });

  function updateSelection() {
    const text = selectedCompany ? (selectedLine ? `${selectedCompany} › ${selectedLine}` : selectedCompany) : "全国の路線";
    selectionText.textContent = text;
    mobileSelection.textContent = text;
  }

  function saveToUrl() {
    const url = new URL(location.href);
    selectedCompany ? url.searchParams.set("company", selectedCompany) : url.searchParams.delete("company");
    selectedLine ? url.searchParams.set("line", selectedLine) : url.searchParams.delete("line");
    history.replaceState(null, "", url);
  }

  async function restoreFromUrl() {
    const params = new URLSearchParams(location.search);
    const company = params.get("company");
    const line = params.get("line");
    if (companyLines.has(company)) {
      if (line && companyLines.get(company).has(line)) selectRoute(company, line, true);
      else selectCompany(company, true);
    } else {
      updateSelection();
    }
  }

  function getGeometryBounds(geometry) {
    const bounds = new maplibregl.LngLatBounds();
    extendBounds(bounds, geometry.coordinates);
    return bounds;
  }

  function extendBounds(bounds, coordinates) {
    if (typeof coordinates[0] === "number") bounds.extend(coordinates);
    else for (const coordinate of coordinates) extendBounds(bounds, coordinate);
  }

  async function fetchJson(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error(`${path}: ${response.status}`);
    return response.json();
  }

  function readBooleanSetting(key, defaultValue) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? defaultValue : value === "true";
    } catch {
      return defaultValue;
    }
  }

  function writeBooleanSetting(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // Storage may be unavailable in private or restricted browsing modes.
    }
  }

  function closeSidebar() { document.body.classList.remove("sidebar-open"); }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char])); }
  function highlight(value, query) {
    const safe = escapeHtml(value);
    if (!query) return safe;
    const index = value.toLocaleLowerCase("ja").indexOf(query);
    return index < 0 ? safe : `${escapeHtml(value.slice(0, index))}<mark>${escapeHtml(value.slice(index, index + query.length))}</mark>${escapeHtml(value.slice(index + query.length))}`;
  }
}
