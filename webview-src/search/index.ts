// webview-src/search/index.ts
//
// Search webview bootstrap and runtime. Phase 1 of the search render overhaul:
// this is a byte-equivalent lift of the script body that previously lived
// inside SearchPanel.getWebviewContent()'s template literal. Logic is
// unchanged — only string escaping is normalised (\` → `, \${ → ${).
//
// Phase 2 will dismantle this monolith into ResultStore + ListRenderer +
// TreeRenderer modules. Until then, treat this file as the existing webview
// JS, just hoisted into a real source file.
//
// TODO(Phase 2): Remove @ts-nocheck and add proper types throughout.
// The original code is plain JS with no type annotations; adding ~65 type
// assertions across scattered DOM event handlers would constitute a redesign
// rather than a lift-and-shift. Phase 2 will dismantle this monolith anyway.
// @ts-nocheck

import { info, diag, getVsCodeApi } from './log';

// Use the singleton in log.ts. Calling acquireVsCodeApi() a second time would
// throw "An instance of the VS Code API has already been acquired".
const vscode = getVsCodeApi();
info('search-webview', 'ready', { domReadyMs: Math.round(performance.now()) });

    // State
    let scopes = [];
    let serverList = [];       // New cross-server search model
    let globalMaxSearchProcesses = 20; // Updated from state messages
    // --- Tab state management ---
    // Each tab (kept or Current) owns its own isolated state.
    function createTabState(overrides) {
      return Object.assign({
        id: Date.now().toString(),
        query: '',
        include: '',
        exclude: '',
        caseSensitive: false,
        useRegex: false,
        wholeWord: false,
        findFilesMode: false,
        results: [],
        scopeServers: [],
        hitLimit: false,
        limit: 2000,
        searchId: null,
        searching: false,
        timestamp: Date.now(),
        expandedFiles: new Set(),
        expandedTreeNodes: new Set(),
        treeViewFirstExpand: true,
        searchExpandState: 2,
        viewMode: 'list',
      }, overrides || {});
    }

    let resultTabs = [];              // Array of kept tab state objects
    let activeTabId = null;           // null = Current tab
    let currentTab = createTabState(); // The "Current" tab's state (always exists)
    let tabSearchIdMap = {};          // { searchId: tabId } — routes searchBatch to kept tabs

    // Per-tab state aliases (updated by save/restore on tab switch)
    let caseSensitive = false;
    let useRegex = false;
    let wholeWord = false;
    let findFilesMode = false;
    let expandedFiles = new Set();
    let viewMode = 'list';
    let expandedTreeNodes = new Set();
    let treeViewFirstExpand = true;
    let searchExpandState = 2;

    // Global state (shared across all tabs)
    let sortOrder = 'checked';
    let currentDisplayScopeServers = [];
    let lastClickedServerIndex = -1;
    let currentSearchId = 0;

    function getActiveTabState() {
      if (activeTabId) return resultTabs.find(function(t) { return t.id === activeTabId; });
      return currentTab;
    }

    function saveCurrentInputState() {
      var tab = getActiveTabState();
      if (!tab) return;
      tab.query = searchInput.value;
      tab.include = includeInput.value;
      tab.exclude = excludeInput.value;
      tab.caseSensitive = caseSensitive;
      tab.useRegex = useRegex;
      tab.wholeWord = wholeWord;
      tab.findFilesMode = findFilesMode;
      tab.viewMode = viewMode;
      tab.searchExpandState = searchExpandState;
      tab.expandedFiles = new Set(expandedFiles);
      tab.expandedTreeNodes = new Set(expandedTreeNodes);
      tab.treeViewFirstExpand = treeViewFirstExpand;
    }

    function restoreTabState(tab) {
      searchInput.value = tab.query || '';
      includeInput.value = tab.include || '';
      excludeInput.value = tab.exclude || '';
      caseSensitive = tab.caseSensitive || false;
      useRegex = tab.useRegex || false;
      wholeWord = tab.wholeWord || false;
      findFilesMode = tab.findFilesMode || false;
      viewMode = tab.viewMode || 'list';
      searchExpandState = tab.searchExpandState != null ? tab.searchExpandState : 2;
      expandedFiles = new Set(tab.expandedFiles || []);
      expandedTreeNodes = new Set(tab.expandedTreeNodes || []);
      treeViewFirstExpand = tab.treeViewFirstExpand != null ? tab.treeViewFirstExpand : true;
      // Update toggle button UI
      caseSensitiveBtn.classList.toggle('active', caseSensitive);
      wholeWordBtn.classList.toggle('active', wholeWord);
      regexBtn.classList.toggle('active', useRegex);
      findFilesBtn.classList.toggle('active', findFilesMode);
      searchInput.placeholder = findFilesMode ? 'Find Files by Name' : 'Search';
      // Update search/cancel button visibility
      if (tab.searching) {
        searchBtn.style.display = 'none';
        cancelBtn.style.display = 'inline-block';
      } else {
        searchBtn.style.display = 'inline-block';
        cancelBtn.style.display = 'none';
      }
    }

    function cleanupTab(tab) {
      // LITE: free memory
      if (tab) {
        tab.results = [];
        tab.scopeServers = [];
        tab.expandedFiles = null;
        tab.expandedTreeNodes = null;
      }
    }

    // Elements
    const searchInput = document.getElementById('searchInput');
    const includeInput = document.getElementById('includeInput');
    const excludeInput = document.getElementById('excludeInput');
    const caseSensitiveBtn = document.getElementById('caseSensitiveBtn');
    const wholeWordBtn = document.getElementById('wholeWordBtn');
    const regexBtn = document.getElementById('regexBtn');
    const findFilesBtn = document.getElementById('findFilesBtn');
    const searchBtn = document.getElementById('searchBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const sortToggleBtn = document.getElementById('sortToggleBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const selectNoneBtn = document.getElementById('selectNoneBtn');
    const serverListEl = document.getElementById('serverList');
    const resultTabBar = document.getElementById('resultTabBar');
    const resultsHeader = document.getElementById('resultsHeader');
    const resultsContainer = document.getElementById('resultsContainer');
    const patternToggle = document.getElementById('patternToggle');
    const patternChevron = document.getElementById('patternChevron');
    const patternFields = document.getElementById('patternFields');
    const resizer = document.getElementById('resizer');
    const controlsSection = document.querySelector('.controls-section');

    // Initialize
    function init() {
      // Search only on Enter key press
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          performSearch();
        }
      });

      // Search button click
      searchBtn.addEventListener('click', () => {
        performSearch();
      });

      // Cancel button click
      cancelBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'cancelSearch' });
      });

      // Pattern toggle (collapsible)
      patternToggle.addEventListener('click', () => {
        const isExpanded = patternFields.classList.contains('expanded');
        patternFields.classList.toggle('expanded', !isExpanded);
        patternChevron.classList.toggle('collapsed', isExpanded);
      });

      // Pattern inputs - trigger search on Enter only
      includeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          performSearch();
        }
      });
      excludeInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          performSearch();
        }
      });

      // Toggle buttons
      caseSensitiveBtn.addEventListener('click', () => {
        caseSensitive = !caseSensitive;
        caseSensitiveBtn.classList.toggle('active', caseSensitive);
        performSearch();
      });

      wholeWordBtn.addEventListener('click', () => {
        wholeWord = !wholeWord;
        wholeWordBtn.classList.toggle('active', wholeWord);
        performSearch();
      });

      regexBtn.addEventListener('click', () => {
        useRegex = !useRegex;
        regexBtn.classList.toggle('active', useRegex);
        performSearch();
      });

      // Find files mode toggle
      findFilesBtn.addEventListener('click', () => {
        findFilesMode = !findFilesMode;
        findFilesBtn.classList.toggle('active', findFilesMode);
        searchInput.placeholder = findFilesMode ? 'Find Files by Name' : 'Search';
        findFilesBtn.title = findFilesMode
          ? 'Search File Content \u2014 search for text inside files'
          : 'Find Files by Name \u2014 search for filenames instead of file content';
      });

      // Server list actions
      sortToggleBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'toggleSort' });
      });

      selectAllBtn.addEventListener('click', () => {
        serverList.forEach(s => {
          if (!s.disabled) {
            vscode.postMessage({ type: 'toggleServer', serverId: s.id, checked: true });
          }
        });
      });

      selectNoneBtn.addEventListener('click', () => {
        vscode.postMessage({ type: 'clearScopes' });
      });

      // Resizer drag functionality (horizontal - width resize)
      let isResizing = false;
      let startX = 0;
      let startWidth = 0;

      resizer.addEventListener('mousedown', (e) => {
        isResizing = true;
        startX = e.clientX;
        startWidth = controlsSection.offsetWidth;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const deltaX = e.clientX - startX;
        const newWidth = Math.max(200, Math.min(window.innerWidth * 0.8, startWidth + deltaX));
        controlsSection.style.width = newWidth + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (isResizing) {
          isResizing = false;
          resizer.classList.remove('dragging');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
        }
      });

      // Notify extension we're ready
      vscode.postMessage({ type: 'ready' });
    }

    // Perform search
    function performSearch() {
      const query = searchInput.value.trim();
      // Check if any server is checked (new model) or legacy scopes exist
      const hasServerScopes = serverList.some(s => s.checked && !s.disabled);
      if (!query || (!hasServerScopes && scopes.length === 0)) {
        showNoResults();
        return;
      }

      vscode.postMessage({
        type: 'search',
        query,
        include: includeInput.value.trim(),
        exclude: excludeInput.value.trim(),
        caseSensitive,
        regex: useRegex,
        wholeWord,
        findFiles: findFilesMode
      });
    }

    // Render server list (replaces old renderScopes)
    function renderServers() {
      if (serverList.length === 0) {
        serverListEl.innerHTML = '<div class="no-servers">No servers configured.</div>';
        return;
      }

      let html = '';
      serverList.forEach((server, idx) => {
        const statusIcon = server.status === 'connecting' ? '\u{1F504}'
          : server.status === 'failed' ? '\u{274C}'
          : server.connected ? '\u{1F7E2}'
          : server.hasCredential ? '\u{26A1}'
          : '\u{26AA}';

        const statusTitle = server.status === 'connecting' ? 'Connecting to server...'
          : server.status === 'failed' ? ('Connection failed: ' + escapeHtml(server.error || 'Unknown error'))
          : server.connected ? 'Include this server in search'
          : server.hasCredential ? 'Include this server \u2014 will auto-connect using saved credentials'
          : 'Save credentials first to search this server';

        const disabledAttr = server.disabled ? ' disabled' : '';
        const disabledClass = server.disabled ? ' disabled' : '';
        const checkedAttr = server.checked ? ' checked' : '';
        const displayName = escapeHtml(server.name) + ' (' + escapeHtml(server.username) + ')';
        const fullTitle = escapeHtml(server.name) + ' (' + escapeHtml(server.username) + ') \u2014 ' + escapeHtml(server.host) + ':' + server.port;

        html += '<div class="server-group">';
        html += '<div class="server-row' + disabledClass + '" tabindex="0" data-server-id="' + escapeHtml(server.id) + '" data-server-idx="' + idx + '" title="' + fullTitle + '">';
        html += '<input type="checkbox" class="server-checkbox" data-server-id="' + escapeHtml(server.id) + '"' + checkedAttr + disabledAttr + ' title="' + escapeHtml(statusTitle) + '">';
        html += '<span class="server-name">' + displayName + '</span>';
        html += '<span class="server-status" title="' + escapeHtml(statusTitle) + '">' + statusIcon + '</span>';
        html += '</div>';

        // Search paths
        html += '<div class="server-paths' + (server.searchPaths.length === 0 ? ' empty' : '') + '">';
        if (server.searchPaths.length > 0) {
          server.searchPaths.forEach((sp, pathIdx) => {
            const pathIcon = sp.isFile ? '\u{1F4C4}' : '\u{1F4C1}';
            let pathClass = 'path-item';
            let pathTitle = escapeHtml(sp.path);
            let warnIcon = '';

            if (sp.redundantOf) {
              pathClass += ' redundant';
              pathTitle = 'Already included by ' + escapeHtml(sp.redundantOf) + ' \u2014 this path will be skipped';
            } else if (sp.overlapWarning) {
              pathClass += ' overlap';
              pathTitle = escapeHtml(sp.overlapWarning) + ' \u2014 results may be duplicated (different permissions)';
              warnIcon = ' \u{26A0}\u{FE0F}';
            }

            html += '<div class="' + pathClass + '">';
            html += '<span class="path-icon">' + pathIcon + '</span>';
            html += '<span class="path-text" title="' + pathTitle + '">' + escapeHtml(sp.path) + warnIcon + '</span>';
            html += '<button class="path-remove" data-server-id="' + escapeHtml(server.id) + '" data-path-idx="' + pathIdx + '" title="Remove this search path">\u00D7</button>';
            html += '</div>';
          });

          // Add folder link (only if server is not disabled)
          if (!server.disabled) {
            html += '<a class="add-path-link" data-server-id="' + escapeHtml(server.id) + '" title="Add another folder to search on this server">+ Add folder</a>';
          }
        } else if (!server.disabled) {
          html += '<span class="no-paths" title="Server will search from / (root). Click + Add folder to narrow scope.">/ (all files)</span>';
          html += '<a class="add-path-link" data-server-id="' + escapeHtml(server.id) + '" title="Add another folder to search on this server" style="display:inline-block">+ Add folder</a>';
        } else {
          html += '<span class="no-paths">(no credentials)</span>';
        }

        // Per-server worker count control
        if (!server.disabled) {
          const hasOverride = server.maxSearchProcesses != null;
          const displayValue = hasOverride ? server.maxSearchProcesses : (globalMaxSearchProcesses || 20);
          const valueClass = hasOverride ? 'processes-value override' : 'processes-value';
          html += '<div class="server-processes" data-server-id="' + escapeHtml(server.id) + '">';
          html += '<span class="processes-label">Workers: </span>';
          html += '<span class="' + valueClass + '">' + displayValue + '</span>';
          if (hasOverride) {
            html += '<span class="processes-default"> (custom)</span>';
            html += '<button class="processes-reset" title="Reset to default (' + (globalMaxSearchProcesses || 20) + ')">\u00D7</button>';
          } else {
            html += '<span class="processes-default"> (default)</span>';
          }
          html += '</div>';
        }

        html += '</div>';
        html += '</div>';
      });

      serverListEl.innerHTML = html;

      // Wire event handlers
      // Checkbox toggle
      serverListEl.querySelectorAll('.server-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
          const serverId = e.target.dataset.serverId;
          const checked = e.target.checked;
          vscode.postMessage({ type: 'toggleServer', serverId, checked });
        });
      });

      // Server row click (toggle checkbox) + shift-click range selection + space key
      serverListEl.querySelectorAll('.server-row').forEach(row => {
        row.addEventListener('click', (e) => {
          // Don't toggle if clicking on checkbox directly or remove button
          if (e.target.tagName === 'INPUT' || e.target.classList.contains('path-remove')) return;

          const serverId = row.dataset.serverId;
          const idx = parseInt(row.dataset.serverIdx);
          const server = serverList.find(s => s.id === serverId);
          if (!server || server.disabled) return;

          if (e.shiftKey && lastClickedServerIndex >= 0) {
            // Range selection
            const from = Math.min(lastClickedServerIndex, idx);
            const to = Math.max(lastClickedServerIndex, idx);
            const targetChecked = !server.checked;
            for (let i = from; i <= to; i++) {
              const s = serverList[i];
              if (s && !s.disabled) {
                vscode.postMessage({ type: 'toggleServer', serverId: s.id, checked: targetChecked });
              }
            }
          } else {
            // Single toggle
            vscode.postMessage({ type: 'toggleServer', serverId, checked: !server.checked });
          }
          lastClickedServerIndex = idx;
        });

        // Space key toggle
        row.addEventListener('keydown', (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            const serverId = row.dataset.serverId;
            const server = serverList.find(s => s.id === serverId);
            if (server && !server.disabled) {
              vscode.postMessage({ type: 'toggleServer', serverId, checked: !server.checked });
            }
          }
        });
      });

      // Path remove buttons
      serverListEl.querySelectorAll('.path-remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const serverId = e.target.dataset.serverId;
          const pathIdx = parseInt(e.target.dataset.pathIdx);
          vscode.postMessage({ type: 'removeServerPath', serverId, pathIndex: pathIdx });
        });
      });

      // Add folder links
      serverListEl.querySelectorAll('.add-path-link').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          const serverId = e.target.dataset.serverId;
          // Create inline input
          const container = e.target.parentElement;
          const inputRow = document.createElement('div');
          inputRow.className = 'path-input-row';
          const input = document.createElement('input');
          input.type = 'text';
          input.className = 'path-input';
          input.placeholder = '/path/to/search';
          inputRow.appendChild(input);
          container.insertBefore(inputRow, e.target);
          input.focus();

          const commit = () => {
            const path = input.value.trim();
            if (path) {
              vscode.postMessage({ type: 'addServerPath', serverId, path });
            }
            inputRow.remove();
          };

          input.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') commit();
            if (ke.key === 'Escape') inputRow.remove();
          });
          input.addEventListener('blur', commit);
        });
      });

      // Workers: click value to edit
      serverListEl.querySelectorAll('.processes-value').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const container = el.closest('.server-processes');
          if (!container) return;
          const serverId = container.dataset.serverId;
          const server = serverList.find(s => s.id === serverId);
          if (!server) return;

          const currentVal = server.maxSearchProcesses || globalMaxSearchProcesses;
          const input = document.createElement('input');
          input.type = 'number';
          input.min = '5';
          input.max = '50';
          input.value = String(currentVal);
          input.className = 'processes-input';

          el.replaceWith(input);
          input.focus();
          input.select();

          const commit = () => {
            const val = parseInt(input.value, 10);
            if (!isNaN(val) && val >= 5 && val <= 50) {
              vscode.postMessage({ type: 'setServerMaxProcesses', serverId, value: val });
            } else {
              renderServers(); // revert
            }
          };

          input.addEventListener('keydown', (ke) => {
            if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
            if (ke.key === 'Escape') { ke.preventDefault(); renderServers(); }
          });
          input.addEventListener('blur', commit);
        });
      });

      // Workers: reset button
      serverListEl.querySelectorAll('.processes-reset').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const container = btn.closest('.server-processes');
          if (!container) return;
          const serverId = container.dataset.serverId;
          vscode.postMessage({ type: 'setServerMaxProcesses', serverId, value: null });
        });
      });
    }

    // Debounced progressive render — 100ms debounce for intermediate batches, immediate on done
    let renderDebounceTimer = null;
    function debouncedRenderResults(hitLimit, limit, done, completedCount, totalCount) {
      if (renderDebounceTimer) {
        clearTimeout(renderDebounceTimer);
        renderDebounceTimer = null;
      }
      const doRender = () => {
        const tab = getActiveTabState();
        const tabResults = tab ? tab.results : [];
        if (tabResults.length === 0 && !done) {
          // Still searching, no results yet — show progress in searching indicator
          resultsHeader.style.display = 'flex';
          resultsHeader.innerHTML = '<span class="results-count">Searching... (' + completedCount + '/' + totalCount + ' done)</span>';
          return;
        }
        if (tabResults.length === 0 && done) {
          showNoResults();
          return;
        }
        // Save scroll position before re-render
        const scrollTop = resultsContainer.scrollTop;
        renderResults(hitLimit, limit);
        // Override header with progress info while search is in progress
        if (!done) {
          const countEl = resultsHeader.querySelector('.results-count');
          if (countEl) {
            const fileCount = new Set(tabResults.map(r => r.connectionId + ':' + r.path)).size;
            countEl.innerHTML = tabResults.length + ' result' + (tabResults.length !== 1 ? 's' : '') + ' in ' +
              fileCount + ' file' + (fileCount !== 1 ? 's' : '') +
              ' <span style="opacity: 0.7">(' + completedCount + '/' + totalCount + ' done...)</span>';
          }
        }
        // Restore scroll position
        resultsContainer.scrollTop = scrollTop;
      };

      if (done) {
        doRender(); // Final batch: render immediately
      } else {
        renderDebounceTimer = setTimeout(doRender, 100);
      }
    }

    // Render results
    function renderResults(hitLimit = false, limit = 2000) {
      // Always update tab bar
      renderTabBar();

      // Determine which data to display from active tab state
      const tab = getActiveTabState();
      const displayResults = tab.results;
      const displayScopeServers = tab.scopeServers;
      const displayHitLimit = tab.hitLimit || hitLimit;
      const displayLimit = tab.limit || limit;
      const displayQuery = tab.query || '';

      if (displayResults.length === 0) {
        showNoResults();
        return;
      }

      // Group by file
      const grouped = {};
      for (const result of displayResults) {
        const key = result.connectionId + ':' + result.path;
        if (!grouped[key]) {
          grouped[key] = {
            path: result.path,
            connectionId: result.connectionId,
            connectionName: result.connectionName,
            size: result.size,
            modified: result.modified,
            matches: []
          };
        }
        grouped[key].matches.push(result);
      }

      const fileGroups = Object.values(grouped);
      const fileCount = fileGroups.length;
      const matchCount = displayResults.length;

      // Set display scope servers for child render functions
      currentDisplayScopeServers = displayScopeServers;

      // Determine multi-server mode from scope servers (not just results)
      // This ensures server grouping appears even if one server returned zero results
      const multiServer = displayScopeServers.length > 1;

      // Count results per server for summary display
      const serverCounts = {};
      for (const result of displayResults) {
        const sKey = result.connectionId;
        if (!serverCounts[sKey]) {
          serverCounts[sKey] = { name: result.connectionName, count: 0 };
        }
        serverCounts[sKey].count++;
      }
      const serverNames = multiServer ? displayScopeServers : Object.values(serverCounts);

      // Render header with view toggle buttons
      resultsHeader.style.display = 'flex';
      let limitWarning = '';
      if (displayHitLimit) {
        limitWarning = ` <span class="limit-warning" title="Click to increase limit">⚠️ Limit ${displayLimit} reached - <a href="#" id="increaseLimitLink">increase limit</a></span>`;
      }
      // Show per-server counts when results span multiple servers
      let serverSummary = '';
      if (multiServer) {
        serverSummary = ' (' + displayScopeServers.map(s => {
          const count = serverCounts[s.id] ? serverCounts[s.id].count : 0;
          return escapeHtml(s.name) + ': ' + count;
        }).join(', ') + ')';
      }
      const showPinBtn = !activeTabId && displayResults.length > 0;
      resultsHeader.innerHTML = `
        <span class="results-count">${matchCount} result${matchCount !== 1 ? 's' : ''} in ${fileCount} file${fileCount !== 1 ? 's' : ''}${serverSummary}${limitWarning}</span>
        ${showPinBtn ? '<button id="keepResultsBtn" class="view-toggle-btn" title="Keep Results (Pin)"><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="vertical-align:middle"><path d="M10.97 2.29a.75.75 0 0 1 .073.976l-.073.084L9.06 5.26l1.57 1.57 1.73-1.72a.75.75 0 0 1 1.133.976l-.073.084-1.73 1.72.97.97a.75.75 0 0 1-.976 1.133l-.084-.073L9.87 8.19 7.81 10.25l.97.97a.75.75 0 0 1-.976 1.133l-.084-.073-4.5-4.5a.75.75 0 0 1 .976-1.133l.084.073.97.97 2.06-2.06-1.73-1.72a.75.75 0 0 1 .976-1.133l.084.073 1.73 1.72L9.91 2.29a.75.75 0 0 1 1.06 0z"/></svg></button>' : ''}
        <button id="expandToggleBtn" class="view-toggle-btn" title="${getExpandToggleTitle()}">${getExpandToggleIcon()}</button>
        <button id="listViewBtn" class="view-toggle-btn ${viewMode === 'list' ? 'active' : ''}" title="List View">☰</button>
        <button id="treeViewBtn" class="view-toggle-btn ${viewMode === 'tree' ? 'active' : ''}" title="Tree View"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style="vertical-align: middle;"><path d="M1 2h6v1.5H1zm4 4h6v1.5H5zm0 4h6v1.5H5zM3 3.5h1.5v3H3zm0 4h1.5v3H3z"/></svg></button>
      `;

      // Add view toggle handlers
      setTimeout(() => {
        const listBtn = document.getElementById('listViewBtn');
        const treeBtn = document.getElementById('treeViewBtn');
        const expandToggle = document.getElementById('expandToggleBtn');
        const limitLink = document.getElementById('increaseLimitLink');
        const keepBtn = document.getElementById('keepResultsBtn');

        if (keepBtn) {
          keepBtn.addEventListener('click', () => {
            const activeTab = getActiveTabState();
            if (!activeTab || activeTab.results.length === 0) return;

            // Save current input state into the tab being kept
            saveCurrentInputState();

            // Move currentTab to resultTabs (it becomes a kept tab)
            if (!activeTabId) {
              resultTabs.push(currentTab);
              if (resultTabs.length > 10) {
                const evicted = resultTabs.shift();
                if (evicted && evicted.searchId) delete tabSearchIdMap[evicted.searchId];
                if (evicted) cleanupTab(evicted);
              }
              // Route future searchBatch for this searchId to the kept tab
              if (currentTab.searching && currentTab.searchId) {
                tabSearchIdMap[currentTab.searchId] = currentTab.id;
                // Notify extension to preserve this search (don't abort on new search)
                vscode.postMessage({ type: 'keepSearch', searchId: currentTab.searchId });
              }
              // Create a fresh Current tab
              currentTab = createTabState();
              activeTabId = null;
            }

            restoreTabState(currentTab);
            renderTabBar();
            renderResults();
          });
        }
        if (expandToggle) {
          expandToggle.addEventListener('click', () => {
            // Cycle: 0 → 1 (expand all) → 2 (file level) → 0 (collapse all)
            const nextState = (searchExpandState + 1) % 3;
            applySearchExpandState(nextState, fileGroups);
            renderResults(displayHitLimit, displayLimit);
          });
        }
        if (listBtn) {
          listBtn.addEventListener('click', () => {
            viewMode = 'list';
            renderResults(displayHitLimit, displayLimit);
          });
        }
        if (treeBtn) {
          treeBtn.addEventListener('click', () => {
            const wasListMode = viewMode === 'list';
            viewMode = 'tree';
            // If switching from list to tree for the first time, expand all nodes
            if (wasListMode && treeViewFirstExpand) {
              treeViewFirstExpand = false;
              expandAllTreeNodes(fileGroups);
            }
            renderResults(displayHitLimit, displayLimit);
          });
        }
        if (limitLink) {
          limitLink.addEventListener('click', (e) => {
            e.preventDefault();
            vscode.postMessage({ type: 'increaseLimit' });
          });
        }
      }, 0);

      // Render based on view mode
      if (viewMode === 'tree') {
        renderTreeView(fileGroups, multiServer, displayQuery);
      } else {
        renderListView(fileGroups, multiServer, displayQuery);
      }
    }

    // Render list view (default)
    function renderListView(fileGroups, multiServer, displayQuery) {
      function renderFileGroup(group) {
        const fileName = group.path.split('/').pop();
        const dirPath = group.path.substring(0, group.path.length - fileName.length - 1) || '/';
        const fileKey = group.connectionId + ':' + group.path;
        const isExpanded = expandedFiles.has(fileKey);

        return `
          <div class="file-group" data-file-key="${escapeHtml(fileKey)}">
            <div class="file-header" data-file-key="${escapeHtml(fileKey)}" data-path="${escapeHtml(group.path)}" data-connection="${escapeHtml(group.connectionId)}">
              <span class="chevron ${isExpanded ? '' : 'collapsed'}">▼</span>
              <span class="file-icon">📄</span>
              <span class="file-name">${escapeHtml(fileName)}</span>
              <span class="file-path">${escapeHtml(dirPath)}</span>
              <span class="file-count">${group.matches.length}</span>
              <button class="reveal-btn" title="Reveal in File Tree" data-path="${escapeHtml(group.path)}" data-connection="${escapeHtml(group.connectionId)}">📍</button>
            </div>
            <div class="match-list ${isExpanded ? 'expanded' : ''}" data-file-key="${escapeHtml(fileKey)}">
              ${group.matches.map(match => `
                <div class="match-item" data-path="${escapeHtml(match.path)}" data-connection="${escapeHtml(match.connectionId)}" data-line="${match.line || ''}">
                  <span class="match-line">${match.line || ''}</span>
                  <span class="match-text">${highlightMatch(match.match || '', displayQuery, caseSensitive)}</span>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }

      if (multiServer) {
        // Group file groups by server - pre-populate from currentDisplayScopeServers so all servers appear
        const serverGroups = {};
        for (const ss of currentDisplayScopeServers) {
          serverGroups[ss.id] = { name: ss.name, id: ss.id, files: [] };
        }
        for (const group of fileGroups) {
          if (!serverGroups[group.connectionId]) {
            serverGroups[group.connectionId] = { name: group.connectionName, id: group.connectionId, files: [] };
          }
          serverGroups[group.connectionId].files.push(group);
        }

        resultsContainer.innerHTML = Object.values(serverGroups).map(server => {
          const serverKey = 'server:' + server.id;
          const isServerExpanded = !expandedFiles.has(serverKey + ':collapsed');
          const totalMatches = server.files.reduce((sum, f) => sum + f.matches.length, 0);

          return `
            <div class="server-group" data-server-key="${escapeHtml(serverKey)}">
              <div class="server-header" data-server-key="${escapeHtml(serverKey)}">
                <span class="chevron ${isServerExpanded ? '' : 'collapsed'}">▼</span>
                <span class="server-icon">🖥️</span>
                <span class="server-name">${escapeHtml(server.name)}</span>
                <span class="server-count">${totalMatches} result${totalMatches !== 1 ? 's' : ''} in ${server.files.length} file${server.files.length !== 1 ? 's' : ''}</span>
              </div>
              <div class="server-files ${isServerExpanded ? 'expanded' : ''}" data-server-key="${escapeHtml(serverKey)}">
                ${server.files.length > 0 ? server.files.map(group => renderFileGroup(group)).join('') : '<div class="no-results" style="padding: 8px 16px;">No results</div>'}
              </div>
            </div>
          `;
        }).join('');
      } else {
        resultsContainer.innerHTML = fileGroups.map(group => renderFileGroup(group)).join('');
      }

      // Add click handlers for server headers (toggle expand/collapse)
      resultsContainer.querySelectorAll('.server-header').forEach(header => {
        header.addEventListener('click', () => {
          const serverKey = header.dataset.serverKey;
          const serverGroup = header.closest('.server-group');
          const serverFiles = serverGroup.querySelector('.server-files');
          const chevron = header.querySelector('.chevron');
          const collapseKey = serverKey + ':collapsed';

          if (expandedFiles.has(collapseKey)) {
            expandedFiles.delete(collapseKey);
            serverFiles.classList.add('expanded');
            chevron.classList.remove('collapsed');
          } else {
            expandedFiles.add(collapseKey);
            serverFiles.classList.remove('expanded');
            chevron.classList.add('collapsed');
          }
        });
      });

      // Add click handlers for file headers (toggle expand/collapse)
      resultsContainer.querySelectorAll('.file-header').forEach(header => {
        header.addEventListener('click', (e) => {
          const fileKey = header.dataset.fileKey;
          const group = header.closest('.file-group');
          const matchList = group.querySelector('.match-list');
          const chevron = header.querySelector('.chevron');

          if (expandedFiles.has(fileKey)) {
            expandedFiles.delete(fileKey);
            matchList.classList.remove('expanded');
            chevron.classList.add('collapsed');
          } else {
            expandedFiles.add(fileKey);
            matchList.classList.add('expanded');
            chevron.classList.remove('collapsed');
          }
        });
      });

      // Add click handlers for reveal buttons
      resultsContainer.querySelectorAll('.reveal-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const path = btn.dataset.path;
          const connectionId = btn.dataset.connection;
          vscode.postMessage({
            type: 'revealInTree',
            result: { path, connectionId }
          });
        });
      });

      addMatchClickHandlers();
    }

    // Build tree structure from file groups
    function buildTree(fileGroups) {
      const tree = {};

      for (const group of fileGroups) {
        const parts = group.path.split('/').filter(Boolean);
        let current = tree;

        // Build directory structure
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i];
          if (!current[part]) {
            current[part] = { _isDir: true, _children: {}, _matches: [], _connectionId: group.connectionId };
          }
          current = current[part]._children;
        }

        // Add file
        const fileName = parts[parts.length - 1] || group.path;
        current[fileName] = {
          _isDir: false,
          _path: group.path,
          _connectionId: group.connectionId,
          _matches: group.matches
        };
      }

      return tree;
    }

    // Count matches in a tree node recursively
    function countTreeMatches(node) {
      if (!node._isDir) {
        return node._matches ? node._matches.length : 0;
      }
      let count = 0;
      for (const key of Object.keys(node._children)) {
        count += countTreeMatches(node._children[key]);
      }
      return count;
    }

    // Expand all tree nodes to FILE level (used when first switching to tree view)
    // Only expands directories, not files - so matches inside files stay collapsed
    function expandAllTreeNodes(fileGroups) {
      const tree = buildTree(fileGroups);

      function collectDirectoryKeys(name, node, parentPath) {
        const nodePath = parentPath ? parentPath + '/' + name : name;
        const nodeKey = (node._connectionId || '') + ':' + nodePath;

        // Only expand directories, not files
        // Files stay collapsed so their matches don't show
        if (node._isDir) {
          expandedTreeNodes.add(nodeKey);
          for (const childName of Object.keys(node._children)) {
            collectDirectoryKeys(childName, node._children[childName], nodePath);
          }
        }
        // Don't add file nodes - they stay collapsed
      }

      // Collect directory node keys from root level
      for (const name of Object.keys(tree)) {
        collectDirectoryKeys(name, tree[name], '');
      }
    }

    // Collect tree node keys for expand state (dirs only, or dirs + files)
    function collectTreeKeys(fileGroups, includeFiles) {
      const tree = buildTree(fileGroups);
      function collect(name, node, parentPath) {
        const nodePath = parentPath ? parentPath + '/' + name : name;
        const nodeKey = (node._connectionId || '') + ':' + nodePath;
        if (node._isDir) {
          expandedTreeNodes.add(nodeKey);
          for (const childName of Object.keys(node._children)) {
            collect(childName, node._children[childName], nodePath);
          }
        } else if (includeFiles) {
          expandedTreeNodes.add(nodeKey);
        }
      }
      for (const name of Object.keys(tree)) {
        collect(name, tree[name], '');
      }
    }

    // Apply search expand state: 0=collapsed, 1=all expanded, 2=file level
    function applySearchExpandState(state, fileGroups) {
      searchExpandState = state;
      expandedTreeNodes.clear();
      expandedFiles.clear();

      if (viewMode === 'tree') {
        if (state === 0) {
          // Collapse all: servers collapsed + tree collapsed
          for (const server of currentDisplayScopeServers) {
            expandedFiles.add('server:' + server.id + ':collapsed');
          }
        } else if (state === 1) {
          // Expand all: servers expanded + dirs + files
          collectTreeKeys(fileGroups, true);
        } else {
          // File level: servers expanded + dirs only
          collectTreeKeys(fileGroups, false);
        }
      } else {
        // List view
        if (state === 0) {
          // Collapse all: servers collapsed + files collapsed
          for (const server of currentDisplayScopeServers) {
            expandedFiles.add('server:' + server.id + ':collapsed');
          }
        } else if (state === 1) {
          // Expand all: servers expanded + file match lists expanded
          for (const group of fileGroups) {
            expandedFiles.add(group.connectionId + ':' + group.path);
          }
        }
        // State 2: files clear = servers expanded, file match lists collapsed
      }
    }

    // Get expand toggle button icon based on current state
    function getExpandToggleIcon() {
      if (searchExpandState === 0) return '⊞';  // expand all
      if (searchExpandState === 1) return '≡';   // to file level
      return '⊟';                                // collapse all
    }

    // Get expand toggle button tooltip based on current state
    function getExpandToggleTitle() {
      if (searchExpandState === 0) return 'Expand All';
      if (searchExpandState === 1) return 'Collapse to File Level';
      return 'Collapse All';
    }

    // Render tree view
    function renderTreeView(fileGroups, multiServer, displayQuery) {
      function renderNode(name, node, indent, parentPath) {
        const nodePath = parentPath ? parentPath + '/' + name : name;
        const nodeKey = (node._connectionId || '') + ':' + nodePath;
        const isExpanded = expandedTreeNodes.has(nodeKey);

        if (node._isDir) {
          const matchCount = countTreeMatches(node);
          const childrenHtml = Object.keys(node._children)
            .sort((a, b) => {
              // Directories first, then files
              const aIsDir = node._children[a]._isDir;
              const bIsDir = node._children[b]._isDir;
              if (aIsDir && !bIsDir) return -1;
              if (!aIsDir && bIsDir) return 1;
              return a.localeCompare(b);
            })
            .map(childName => renderNode(childName, node._children[childName], indent + 1, nodePath))
            .join('');

          return `
            <div class="tree-node tree-folder" data-node-key="${escapeHtml(nodeKey)}">
              <div class="tree-folder-header" style="--indent: ${indent};" data-node-key="${escapeHtml(nodeKey)}">
                <span class="chevron ${isExpanded ? '' : 'collapsed'}">▼</span>
                <span class="tree-folder-icon">${isExpanded ? '📂' : '📁'}</span>
                <span class="tree-folder-name">${escapeHtml(name)}</span>
                <span class="tree-folder-count">(${matchCount})</span>
              </div>
              <div class="tree-folder-children ${isExpanded ? 'expanded' : ''}" data-node-key="${escapeHtml(nodeKey)}">
                ${childrenHtml}
              </div>
            </div>
          `;
        } else {
          // File node
          const matchCount = node._matches ? node._matches.length : 0;
          const matchesHtml = node._matches ? node._matches.map(match => `
            <div class="tree-match-item" data-path="${escapeHtml(match.path)}" data-connection="${escapeHtml(match.connectionId)}" data-line="${match.line || ''}">
              <span class="match-line">${match.line || ''}</span>
              <span class="match-text">${highlightMatch(match.match || '', displayQuery, caseSensitive)}</span>
            </div>
          `).join('') : '';

          return `
            <div class="tree-node" data-node-key="${escapeHtml(nodeKey)}">
              <div class="tree-file" style="--indent: ${indent};" data-node-key="${escapeHtml(nodeKey)}" data-path="${escapeHtml(node._path)}" data-connection="${escapeHtml(node._connectionId)}">
                <span class="chevron ${isExpanded ? '' : 'collapsed'}">▼</span>
                <span class="tree-file-icon">📄</span>
                <span class="tree-file-name">${escapeHtml(name)}</span>
                <span class="tree-file-count">${matchCount}</span>
                <button class="reveal-btn" title="Reveal in File Tree" data-path="${escapeHtml(node._path)}" data-connection="${escapeHtml(node._connectionId)}">📍</button>
              </div>
              <div class="tree-matches ${isExpanded ? 'expanded' : ''}" style="--indent: ${indent};" data-node-key="${escapeHtml(nodeKey)}">
                ${matchesHtml}
              </div>
            </div>
          `;
        }
      }

      // Render a tree structure into HTML
      function renderTree(tree) {
        return Object.keys(tree)
          .sort((a, b) => {
            const aIsDir = tree[a]._isDir;
            const bIsDir = tree[b]._isDir;
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a.localeCompare(b);
          })
          .map(name => renderNode(name, tree[name], 0, ''))
          .join('');
      }

      if (multiServer) {
        // Group file groups by server - pre-populate from currentDisplayScopeServers so all servers appear
        const serverGroups = {};
        for (const ss of currentDisplayScopeServers) {
          serverGroups[ss.id] = { name: ss.name, id: ss.id, files: [] };
        }
        for (const group of fileGroups) {
          if (!serverGroups[group.connectionId]) {
            serverGroups[group.connectionId] = { name: group.connectionName, id: group.connectionId, files: [] };
          }
          serverGroups[group.connectionId].files.push(group);
        }

        resultsContainer.innerHTML = Object.values(serverGroups).map(server => {
          const serverKey = 'server:' + server.id;
          const isServerExpanded = !expandedFiles.has(serverKey + ':collapsed');
          const totalMatches = server.files.reduce((sum, f) => sum + f.matches.length, 0);
          const serverTree = buildTree(server.files);

          return `
            <div class="server-group" data-server-key="${escapeHtml(serverKey)}">
              <div class="server-header" data-server-key="${escapeHtml(serverKey)}">
                <span class="chevron ${isServerExpanded ? '' : 'collapsed'}">▼</span>
                <span class="server-icon">🖥️</span>
                <span class="server-name">${escapeHtml(server.name)}</span>
                <span class="server-count">${totalMatches} result${totalMatches !== 1 ? 's' : ''} in ${server.files.length} file${server.files.length !== 1 ? 's' : ''}</span>
              </div>
              <div class="server-files ${isServerExpanded ? 'expanded' : ''}" data-server-key="${escapeHtml(serverKey)}">
                ${server.files.length > 0 ? renderTree(serverTree) : '<div class="no-results" style="padding: 8px 16px;">No results</div>'}
              </div>
            </div>
          `;
        }).join('');
      } else {
        const tree = buildTree(fileGroups);
        resultsContainer.innerHTML = renderTree(tree);
      }

      // Add server header click handlers
      resultsContainer.querySelectorAll('.server-header').forEach(header => {
        header.addEventListener('click', () => {
          const serverKey = header.dataset.serverKey;
          const serverGroup = header.closest('.server-group');
          const serverFiles = serverGroup.querySelector('.server-files');
          const chevron = header.querySelector('.chevron');
          const collapseKey = serverKey + ':collapsed';

          if (expandedFiles.has(collapseKey)) {
            expandedFiles.delete(collapseKey);
            serverFiles.classList.add('expanded');
            chevron.classList.remove('collapsed');
          } else {
            expandedFiles.add(collapseKey);
            serverFiles.classList.remove('expanded');
            chevron.classList.add('collapsed');
          }
        });
      });

      // Add tree click handlers
      resultsContainer.querySelectorAll('.tree-folder-header').forEach(header => {
        header.addEventListener('click', (e) => {
          const nodeKey = header.dataset.nodeKey;
          const folder = header.closest('.tree-folder');
          const children = folder.querySelector('.tree-folder-children');
          const chevron = header.querySelector('.chevron');
          const icon = header.querySelector('.tree-folder-icon');

          if (expandedTreeNodes.has(nodeKey)) {
            expandedTreeNodes.delete(nodeKey);
            children.classList.remove('expanded');
            chevron.classList.add('collapsed');
            icon.textContent = '📁';
          } else {
            expandedTreeNodes.add(nodeKey);
            children.classList.add('expanded');
            chevron.classList.remove('collapsed');
            icon.textContent = '📂';
          }
        });
      });

      resultsContainer.querySelectorAll('.tree-file').forEach(file => {
        file.addEventListener('click', (e) => {
          const nodeKey = file.dataset.nodeKey;
          const node = file.closest('.tree-node');
          const matches = node.querySelector('.tree-matches');
          const chevron = file.querySelector('.chevron');

          if (expandedTreeNodes.has(nodeKey)) {
            expandedTreeNodes.delete(nodeKey);
            matches.classList.remove('expanded');
            chevron.classList.add('collapsed');
          } else {
            expandedTreeNodes.add(nodeKey);
            matches.classList.add('expanded');
            chevron.classList.remove('collapsed');
          }
        });
      });

      addMatchClickHandlers();
    }

    // Add click handlers for match items (shared by both views)
    function addMatchClickHandlers() {
      resultsContainer.querySelectorAll('.match-item, .tree-match-item').forEach(item => {
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          const path = item.dataset.path;
          const connectionId = item.dataset.connection;
          const line = item.dataset.line ? parseInt(item.dataset.line) : undefined;

          vscode.postMessage({
            type: 'openResult',
            result: { path, connectionId },
            line
          });
        });
      });

      // Add click handlers for reveal buttons (shared by both views)
      resultsContainer.querySelectorAll('.reveal-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const path = btn.dataset.path;
          const connectionId = btn.dataset.connection;
          vscode.postMessage({
            type: 'revealInTree',
            result: { path, connectionId }
          });
        });
      });
    }

    // Show no results
    // Tab bar for kept/pinned results
    function renderTabBar() {
      if (resultTabs.length === 0) {
        resultTabBar.style.display = 'none';
        return;
      }
      resultTabBar.style.display = 'flex';
      let html = '';
      // Kept tabs
      for (const tab of resultTabs) {
        const isActive = activeTabId === tab.id;
        const indicator = tab.searching ? ' \u27F3' : '';
        const label = '"' + escapeHtml(tab.query.substring(0, 20)) + (tab.query.length > 20 ? '...' : '') + '" (' + tab.results.length + ')' + indicator;
        html += '<div class="result-tab' + (isActive ? ' active' : '') + (tab.searching ? ' searching' : '') + '" data-tab-id="' + escapeHtml(tab.id) + '" title="Search: ' + escapeHtml(tab.query) + '">';
        html += '<span class="tab-label">' + label + '</span>';
        html += '<button class="tab-close" data-tab-id="' + escapeHtml(tab.id) + '" title="Close">\u00D7</button>';
        html += '</div>';
      }
      // Current/live tab (always last)
      const isCurrentActive = !activeTabId;
      const currentIndicator = currentTab.searching ? ' \u27F3' : '';
      html += '<div class="result-tab' + (isCurrentActive ? ' active' : '') + (currentTab.searching ? ' searching' : '') + '" data-tab-id="current">';
      html += '<span class="tab-label">Current' + currentIndicator + '</span>';
      html += '</div>';
      resultTabBar.innerHTML = html;

      // Wire tab click handlers
      resultTabBar.querySelectorAll('.result-tab').forEach(tab => {
        tab.addEventListener('click', (e) => {
          // Close button
          if (e.target.classList.contains('tab-close')) {
            const tabId = e.target.dataset.tabId;
            const closedTab = resultTabs.find(function(t) { return t.id === tabId; });
            if (closedTab) {
              // LITE: cancel the server-side search if this tab owns it
              if (closedTab.searching && closedTab.searchId) {
                vscode.postMessage({ type: 'cancelSearch', searchId: closedTab.searchId });
              }
              // Clean up routing
              if (closedTab.searchId) delete tabSearchIdMap[closedTab.searchId];
              // LITE: free memory
              cleanupTab(closedTab);
            }
            resultTabs = resultTabs.filter(function(t) { return t.id !== tabId; });
            if (activeTabId === tabId) {
              activeTabId = null;
              restoreTabState(currentTab);
            }
            renderTabBar();
            renderResults();
            return;
          }
          // Tab selection — save outgoing, restore incoming
          const tabId = tab.dataset.tabId;
          saveCurrentInputState();
          if (tabId === 'current') {
            activeTabId = null;
            restoreTabState(currentTab);
          } else {
            activeTabId = tabId;
            const targetTab = resultTabs.find(function(t) { return t.id === tabId; });
            if (targetTab) restoreTabState(targetTab);
          }
          renderTabBar();
          renderResults();
        });
      });
    }

    function showNoResults() {
      resultsHeader.style.display = 'none';
      const hasAnyScope = scopes.length > 0 || serverList.some(s => s.checked && !s.disabled);
      if (searchInput.value.trim() && hasAnyScope) {
        resultsContainer.innerHTML = '<div class="no-results">No results found</div>';
      } else if (!hasAnyScope) {
        resultsContainer.innerHTML = '<div class="no-results">Select a server to search</div>';
      } else {
        resultsContainer.innerHTML = '';
      }
    }

    // Show searching state
    function showSearching(query) {
      resultsHeader.style.display = 'none';
      resultsContainer.innerHTML = '<div class="searching">Searching...</div>';
    }

    // Escape HTML
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // Highlight search query in match text
    function highlightMatch(text, query, isCaseSensitive) {
      if (!query || !text) {
        return escapeHtml(text);
      }

      // Escape query for regex special chars if not using regex mode
      const escapedQuery = query.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
      const flags = isCaseSensitive ? 'g' : 'gi';
      let regex;
      try {
        regex = new RegExp('(' + escapedQuery + ')', flags);
      } catch {
        // Invalid regex (e.g., catastrophic backtracking pattern) — fall back to plain text
        return escapeHtml(text);
      }

      // Split text by matches and rebuild with highlights
      const parts = text.split(regex);
      return parts.map((part, i) => {
        const escaped = escapeHtml(part);
        // Odd indices are matches (due to capture group)
        if (i % 2 === 1) {
          return '<span class="match-highlight">' + escaped + '</span>';
        }
        return escaped;
      }).join('');
    }

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.type) {
        case 'state':
          scopes = message.scopes || [];
          serverList = message.serverList || [];
          if (message.globalMaxSearchProcesses !== undefined) {
            globalMaxSearchProcesses = message.globalMaxSearchProcesses;
          }
          if (message.findFilesMode !== undefined) {
            findFilesMode = message.findFilesMode;
            currentTab.findFilesMode = findFilesMode;
            findFilesBtn.classList.toggle('active', findFilesMode);
            searchInput.placeholder = findFilesMode ? 'Find Files by Name' : 'Search';
          }
          if (message.wholeWord !== undefined) {
            wholeWord = message.wholeWord;
            currentTab.wholeWord = wholeWord;
            wholeWordBtn.classList.toggle('active', wholeWord);
          }
          if (message.sortOrder) {
            sortOrder = message.sortOrder;
            sortToggleBtn.innerHTML = sortOrder === 'checked' ? '\u2191checked' : '\u2191name';
            sortToggleBtn.title = sortOrder === 'checked'
              ? 'Sort: servers with search paths first'
              : 'Sort: alphabetical by name';
          }
          renderServers();
          // Update button visibility based on search state
          if (message.isSearching) {
            searchBtn.style.display = 'none';
            cancelBtn.style.display = 'inline-block';
          } else {
            searchBtn.style.display = 'inline-block';
            cancelBtn.style.display = 'none';
            // Clear stale "Searching..." message when no search is running
            if (resultsContainer.querySelector('.searching')) {
              resultsContainer.innerHTML = '';
            }
          }
          break;

        case 'searching':
          // Mark any kept tabs still searching as done (old search aborted)
          for (var si = 0; si < resultTabs.length; si++) { if (resultTabs[si].searching) resultTabs[si].searching = false; }
          tabSearchIdMap = {};

          currentSearchId = message.searchId || 0;
          // Update currentTab state for the new search
          currentTab.searchId = currentSearchId;
          currentTab.searching = true;
          currentTab.results = [];
          currentTab.query = message.query || '';
          currentTab.scopeServers = message.scopeServers || [];
          currentTab.searchExpandState = 2;
          currentTab.expandedFiles = new Set();
          currentTab.expandedTreeNodes = new Set();
          currentTab.treeViewFirstExpand = true;
          // Save include/exclude from input fields into currentTab
          currentTab.include = includeInput.value;
          currentTab.exclude = excludeInput.value;

          // Reset per-tab aliases
          searchExpandState = 2;
          expandedFiles = new Set();
          expandedTreeNodes = new Set();
          treeViewFirstExpand = true;

          // Switch to Current tab to see results
          if (activeTabId) {
            saveCurrentInputState();
            activeTabId = null;
            restoreTabState(currentTab);
          }
          renderTabBar();
          showSearching(message.query);
          searchBtn.style.display = 'none';
          cancelBtn.style.display = 'inline-block';
          break;

        case 'searchBatch': {
          var msgSearchId = message.searchId;

          // 1. Check if routed to a kept tab
          var targetTabId = tabSearchIdMap[msgSearchId];
          if (targetTabId) {
            var batchTab = resultTabs.find(function(t) { return t.id === targetTabId; });
            if (batchTab) {
              if (message.results && message.results.length > 0) batchTab.results = batchTab.results.concat(message.results);
              batchTab.hitLimit = message.hitLimit || batchTab.hitLimit;
              if (message.done) {
                batchTab.searching = false;
                delete tabSearchIdMap[msgSearchId];
              }
              if (activeTabId === targetTabId) {
                debouncedRenderResults(batchTab.hitLimit, batchTab.limit, message.done,
                  message.completedCount, message.totalCount);
              } else {
                renderTabBar(); // update count in tab label
              }
              break;
            }
          }

          // 2. Stale message check
          if (msgSearchId && msgSearchId !== currentSearchId) break;

          // 3. Normal current-tab handling — append to currentTab.results
          if (message.results && message.results.length > 0) currentTab.results = currentTab.results.concat(message.results);
          currentTab.hitLimit = message.hitLimit || currentTab.hitLimit;
          if (message.done) {
            currentTab.searching = false;
          }
          // Only re-render if viewing Current tab
          if (!activeTabId) {
            debouncedRenderResults(message.hitLimit, message.limit, message.done,
              message.completedCount, message.totalCount);
          }
          if (message.done) {
            searchBtn.style.display = 'inline-block';
            cancelBtn.style.display = 'none';
          }
          break;
        }

        case 'results': {
          // Check routing map for kept tabs
          var resMsgSearchId = message.searchId;
          var resTargetTabId = tabSearchIdMap[resMsgSearchId];
          if (resTargetTabId) {
            var resTab = resultTabs.find(function(t) { return t.id === resTargetTabId; });
            if (resTab) {
              resTab.results = message.results || [];
              resTab.query = message.query || '';
              resTab.scopeServers = message.scopeServers || [];
              resTab.hitLimit = message.hitLimit || false;
              resTab.limit = message.limit || 2000;
              resTab.searching = false;
              delete tabSearchIdMap[resMsgSearchId];
              if (activeTabId === resTargetTabId) {
                renderResults(message.hitLimit, message.limit);
              } else {
                renderTabBar();
              }
              searchBtn.style.display = 'inline-block';
              cancelBtn.style.display = 'none';
              break;
            }
          }
          // Stale message check
          if (resMsgSearchId && resMsgSearchId !== currentSearchId) break;
          // Current tab handling
          currentTab.results = message.results || [];
          currentTab.query = message.query || '';
          currentTab.scopeServers = message.scopeServers || [];
          currentTab.hitLimit = message.hitLimit || false;
          currentTab.limit = message.limit || 2000;
          currentTab.searching = false;
          currentTab.searchExpandState = 2;
          currentTab.expandedFiles = new Set();
          currentTab.expandedTreeNodes = new Set();
          currentTab.treeViewFirstExpand = true;
          // Reset per-tab aliases
          searchExpandState = 2;
          expandedFiles = new Set();
          expandedTreeNodes = new Set();
          treeViewFirstExpand = true;
          if (!activeTabId) {
            renderResults(message.hitLimit, message.limit);
          }
          searchBtn.style.display = 'inline-block';
          cancelBtn.style.display = 'none';
          break;
        }

        case 'searchCancelled':
          for (var ci = 0; ci < resultTabs.length; ci++) { if (resultTabs[ci].searching) resultTabs[ci].searching = false; }
          tabSearchIdMap = {};
          currentTab.searching = false;
          if (!activeTabId) {
            resultsHeader.style.display = 'none';
            resultsContainer.innerHTML = '<div class="no-results">Search cancelled</div>';
          }
          searchBtn.style.display = 'inline-block';
          cancelBtn.style.display = 'none';
          renderTabBar();
          break;

        case 'error':
          resultsHeader.style.display = 'none';
          resultsContainer.innerHTML = '<div class="no-results">Error: ' + escapeHtml(message.message) + '</div>';
          // Hide cancel button, show search button
          searchBtn.style.display = 'inline-block';
          cancelBtn.style.display = 'none';
          break;

        case 'focusInput':
          searchInput.focus();
          searchInput.select();
          break;
      }
    });

    // Initialize
    init();
