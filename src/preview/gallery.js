/**
 * Gallery Client-Side Logic
 * Handles diagram loading, search, workspace tabs, and interaction
 */

// Get port from script tag data attribute
const currentScript = document.currentScript || document.querySelector("script[data-port]");
const SERVER_PORT = currentScript ? currentScript.getAttribute("data-port") : "3737";

// State
let allDiagrams = [];
let filteredDiagrams = [];
let activeWorkspace = ""; // "" means All
let searchQuery = "";

// DOM Elements
const galleryEl = document.getElementById("gallery");
const emptyStateEl = document.getElementById("emptyState");
const noResultsEl = document.getElementById("noResults");
const searchInput = document.getElementById("searchInput");
const diagramCountEl = document.getElementById("diagramCount");
const tabsEl = document.getElementById("workspaceTabs");

// Messages
const MESSAGES = {
  DELETE_CONFIRM: (workspace, id) =>
    `Are you sure you want to delete diagram "${workspace}/${id}"?`,
  DELETE_FAILED: (error) => `Failed to delete diagram: ${error}`,
};

/**
 * Formats a date as relative time (e.g., "2 hours ago")
 */
function formatRelativeTime(date) {
  const now = new Date();
  const diffMs = now - new Date(date);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour > 1 ? "s" : ""} ago`;
  if (diffDay < 7) return `${diffDay} day${diffDay > 1 ? "s" : ""} ago`;

  return new Date(date).toLocaleDateString();
}

/**
 * Formats file size in human-readable format
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Creates a diagram card element
 */
function createDiagramCard(diagram) {
  const card = document.createElement("div");
  card.className = "diagram-card";
  card.dataset.diagramId = diagram.id;
  card.dataset.workspace = diagram.workspace;

  // Action buttons
  const actions = document.createElement("div");
  actions.className = "diagram-actions";

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "diagram-action-btn delete-btn";
  deleteBtn.innerHTML = "🗑️";
  deleteBtn.title = "Delete";
  deleteBtn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    deleteDiagram(diagram.workspace, diagram.id);
  };

  actions.appendChild(deleteBtn);

  // Card link wrapper — use the live route /<workspace>/<id> so clicking
  // a gallery card opens with WebSocket live-reload enabled.
  const cardLink = document.createElement("a");
  cardLink.href = `/${diagram.workspace}/${diagram.id}`;
  cardLink.className = "diagram-card-link";

  // Preview section
  const preview = document.createElement("div");
  preview.className = "diagram-preview";

  if (diagram.format === "svg") {
    // Load SVG preview from the static /view/ route
    fetch(`/view/${diagram.workspace}/${diagram.id}`)
      .then((response) => response.text())
      .then((html) => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, "text/html");
        const svg = doc.querySelector("svg");
        if (svg) {
          preview.innerHTML = "";
          preview.appendChild(svg.cloneNode(true));
        } else {
          preview.innerHTML = '<div class="diagram-preview-placeholder">📊</div>';
        }
      })
      .catch(() => {
        preview.innerHTML = '<div class="diagram-preview-placeholder">📊</div>';
      });
  } else {
    preview.innerHTML = '<div class="diagram-preview-placeholder">📊</div>';
  }

  // Info section
  const info = document.createElement("div");
  info.className = "diagram-info";

  const id = document.createElement("h3");
  id.className = "diagram-id";

  const wsTag = document.createElement("span");
  wsTag.className = "diagram-workspace";
  wsTag.dataset.workspace = diagram.workspace;
  wsTag.textContent = diagram.workspace;

  id.appendChild(wsTag);
  id.appendChild(document.createTextNode(diagram.id));

  const meta = document.createElement("div");
  meta.className = "diagram-meta";

  const format = document.createElement("span");
  format.className = "diagram-meta-item";
  format.innerHTML = `<span class="diagram-format">${diagram.format}</span>`;

  const modified = document.createElement("span");
  modified.className = "diagram-meta-item";
  modified.innerHTML = `📅 ${formatRelativeTime(diagram.modifiedAt)}`;

  const size = document.createElement("span");
  size.className = "diagram-meta-item";
  size.innerHTML = `💾 ${formatFileSize(diagram.sizeBytes)}`;

  meta.appendChild(format);
  meta.appendChild(modified);
  meta.appendChild(size);

  info.appendChild(id);
  info.appendChild(meta);

  cardLink.appendChild(preview);
  cardLink.appendChild(info);

  card.appendChild(actions);
  card.appendChild(cardLink);

  return card;
}

/**
 * Updates the per-tab badge counts to reflect allDiagrams.
 */
function updateTabCounts() {
  if (!tabsEl) return;
  const counts = { rocketlink: 0, quartz: 0, personal: 0, default: 0 };
  allDiagrams.forEach((d) => {
    if (counts.hasOwnProperty(d.workspace)) counts[d.workspace]++;
  });
  tabsEl.querySelectorAll(".workspace-tab-count").forEach((badge) => {
    const ws = badge.dataset.count;
    if (ws === "") {
      badge.textContent = String(allDiagrams.length);
    } else {
      badge.textContent = String(counts[ws] || 0);
    }
  });
}

/**
 * Renders the gallery with current filtered diagrams
 */
function renderGallery() {
  galleryEl.innerHTML = "";

  const countLabel =
    activeWorkspace === ""
      ? `${filteredDiagrams.length} diagram${filteredDiagrams.length !== 1 ? "s" : ""}`
      : `${filteredDiagrams.length} diagram${filteredDiagrams.length !== 1 ? "s" : ""} in ${activeWorkspace}`;
  diagramCountEl.textContent = countLabel;

  if (allDiagrams.length === 0) {
    galleryEl.style.display = "none";
    emptyStateEl.style.display = "block";
    noResultsEl.style.display = "none";
  } else if (filteredDiagrams.length === 0) {
    galleryEl.style.display = "none";
    emptyStateEl.style.display = "none";
    noResultsEl.style.display = "block";
  } else {
    galleryEl.style.display = "grid";
    emptyStateEl.style.display = "none";
    noResultsEl.style.display = "none";

    filteredDiagrams.forEach((diagram) => {
      const card = createDiagramCard(diagram);
      galleryEl.appendChild(card);
    });
  }
}

/**
 * Recomputes filteredDiagrams from activeWorkspace + searchQuery and re-renders.
 */
function applyFilters() {
  const query = (searchQuery || "").toLowerCase().trim();
  filteredDiagrams = allDiagrams.filter((d) => {
    if (activeWorkspace !== "" && d.workspace !== activeWorkspace) return false;
    if (query && !d.id.toLowerCase().includes(query)) return false;
    return true;
  });
  renderGallery();
}

/**
 * Loads diagrams from the API
 */
async function loadDiagrams() {
  try {
    const response = await fetch(`http://localhost:${SERVER_PORT}/api/diagrams`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    allDiagrams = data.diagrams || [];

    updateTabCounts();
    applyFilters();
  } catch (error) {
    console.error("Failed to load diagrams:", error);
    galleryEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">⚠️</div>
        <h2 class="empty-state-title">Failed to load diagrams</h2>
        <p class="empty-state-description">${error.message}</p>
      </div>
    `;
  }
}

/**
 * Deletes a diagram
 */
async function deleteDiagram(workspace, diagramId) {
  if (!confirm(MESSAGES.DELETE_CONFIRM(workspace, diagramId))) {
    return;
  }

  try {
    const response = await fetch(
      `http://localhost:${SERVER_PORT}/api/diagrams/${workspace}/${diagramId}`,
      { method: "DELETE" }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const index = allDiagrams.findIndex(
      (d) => d.id === diagramId && d.workspace === workspace
    );
    if (index !== -1) {
      allDiagrams.splice(index, 1);
    }

    updateTabCounts();
    applyFilters();
  } catch (error) {
    console.error("Failed to delete diagram:", error);
    alert(MESSAGES.DELETE_FAILED(error.message));
  }
}

/**
 * Debounce function for search input
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// Event Listeners
searchInput.addEventListener(
  "input",
  debounce((e) => {
    searchQuery = e.target.value;
    applyFilters();
  }, 200)
);

if (tabsEl) {
  tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".workspace-tab");
    if (!btn) return;
    const ws = btn.dataset.workspace || "";
    if (ws === activeWorkspace) return;
    activeWorkspace = ws;
    tabsEl.querySelectorAll(".workspace-tab").forEach((b) => {
      const isActive = (b.dataset.workspace || "") === activeWorkspace;
      b.classList.toggle("is-active", isActive);
      b.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    applyFilters();
  });
}

// Initialize
loadDiagrams();
