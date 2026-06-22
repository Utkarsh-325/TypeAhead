// DOM Elements
const searchInput = document.getElementById('search-input');
const suggestionsContainer = document.getElementById('suggestions-container');
const suggestionList = document.getElementById('suggestion-list');
const suggestionsFooter = document.getElementById('suggestions-footer');
const trendingContainer = document.getElementById('trending-container');
const trendingList = document.getElementById('trending-list');
const searchResponsePanel = document.getElementById('search-response-panel');
const responseClose = document.getElementById('response-close');

// Diagnostics DOM
const toggleDiagnosticsBtn = document.getElementById('toggle-diagnostics-btn');
const diagnosticsPanel = document.getElementById('diagnostics-panel');
const p50Val = document.getElementById('p50-val');
const p95Val = document.getElementById('p95-val');
const hitrateVal = document.getElementById('hitrate-val');
const writesSavedVal = document.getElementById('writes-saved-val');
const reductionVal = document.getElementById('reduction-val');
const bufferVal = document.getElementById('buffer-val');
const nodesList = document.getElementById('nodes-list');

// Debugger DOM
const debugPrefixInput = document.getElementById('debug-prefix-input');
const debugBtn = document.getElementById('debug-btn');
const debugResult = document.getElementById('debug-result');
const debugNode = document.getElementById('debug-node');
const debugHash = document.getElementById('debug-hash');
const debugCached = document.getElementById('debug-cached');

// Settings DOM
const configForm = document.getElementById('config-form');
const rankingModeSelect = document.getElementById('ranking-mode');
const batchIntervalInput = document.getElementById('batch-interval');
const batchLimitInput = document.getElementById('batch-limit');
const btnFlush = document.getElementById('action-flush');
const btnClearCache = document.getElementById('action-clear-cache');
const btnLoadTest = document.getElementById('action-load-test');

// App State
let currentSuggestions = [];
let selectedIndex = -1;
let lastInputVal = '';

// Sample Queries for Traffic Simulation
const SIMULATION_QUERIES = [
  'google', 'google maps', 'google earth', 'google search',
  'facebook login', 'youtube', 'weather today', 'amazon prime',
  'gmail login', 'news', 'wikipedia', 'netflix series',
  'python course', 'docker kubernetes', 'java tutorial',
  'standing desk', 'react hooks', 'node js', 'system design',
  'hiking boots', 'keto diet', 'ai tools', 'iphone 15'
];

// Helper to translate backend logical node names to Shard numbers
function getShardName(nodeName) {
  if (nodeName === 'CacheNode-0') return 'shard 1';
  if (nodeName === 'CacheNode-1') return 'shard 2';
  if (nodeName === 'CacheNode-2') return 'shard 3';
  return nodeName;
}

// ----------------------------------------------------
// 1. Fetch & Render Suggestions
// ----------------------------------------------------

async function fetchSuggestions(prefix) {
  const cleanPrefix = prefix.trim();
  
  if (cleanPrefix === '') {
    // If empty input, hide suggestions list, and reveal trending board
    suggestionsContainer.classList.add('hidden');
    trendingContainer.classList.remove('hidden');
    currentSuggestions = [];
    return;
  }

  const mode = rankingModeSelect.value;
  try {
    const response = await fetch(`/suggest?q=${encodeURIComponent(cleanPrefix)}&mode=${mode}`);
    const data = await response.json();
    
    currentSuggestions = data.suggestions || [];
    const shard = getShardName(data.cacheNode || 'CacheNode-0');
    
    renderDropdown(cleanPrefix, shard, data.latencyMs);
    updateMetrics(); // Keep diagnostics fresh in the background
  } catch (error) {
    console.error('Error fetching suggestions:', error);
  }
}

const debouncedFetch = debounce((val) => {
  fetchSuggestions(val);
}, 200);

function renderDropdown(prefix, shard, latencyMs) {
  suggestionList.innerHTML = '';
  selectedIndex = -1;

  if (currentSuggestions.length === 0) {
    // Show empty suggestion indicator or hide suggestions
    suggestionsContainer.classList.add('hidden');
    trendingContainer.classList.remove('hidden');
    return;
  }

  // Hide the trending board to prevent overlap!
  trendingContainer.classList.add('hidden');

  currentSuggestions.forEach((item, index) => {
    const li = document.createElement('li');
    li.className = 'suggestion-item';
    li.dataset.index = index;

    // Bold/highlight the prefix match
    const rawQuery = item.query;
    const prefixLower = prefix.toLowerCase();
    let textHtml = rawQuery;
    
    if (rawQuery.toLowerCase().startsWith(prefixLower)) {
      const matchLen = prefixLower.length;
      textHtml = `<strong>${rawQuery.substring(0, matchLen)}</strong>${rawQuery.substring(matchLen)}`;
    }

    li.innerHTML = `
      <span class="suggestion-text">${textHtml}</span>
      <span class="suggestion-score">${item.score.toLocaleString()}</span>
    `;

    li.addEventListener('click', () => {
      searchInput.value = rawQuery;
      submitSearch(rawQuery);
    });

    li.addEventListener('mouseover', () => {
      setHighlight(index);
    });

    suggestionList.appendChild(li);
  });

  suggestionsFooter.textContent = `${currentSuggestions.length} suggestions - served by ${shard} (in ${latencyMs}ms)`;
  suggestionsContainer.classList.remove('hidden');
}

function setHighlight(index) {
  const items = suggestionList.querySelectorAll('.suggestion-item');
  items.forEach(item => item.classList.remove('selected'));
  
  if (index >= 0 && index < items.length) {
    items[index].classList.add('selected');
    selectedIndex = index;
  } else {
    selectedIndex = -1;
  }
}

// ----------------------------------------------------
// 2. Search Submissions
// ----------------------------------------------------

async function submitSearch(query) {
  const cleanQuery = query.trim();
  if (!cleanQuery) return;

  // Clear focus and inputs
  suggestionsContainer.classList.add('hidden');
  trendingContainer.classList.remove('hidden');
  searchInput.blur();
  lastInputVal = '';

  try {
    await fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: cleanQuery })
    });
    
    // Display dummy api alert notification
    searchResponsePanel.classList.remove('hidden');
    setTimeout(() => {
      searchResponsePanel.classList.add('hidden');
    }, 4000); // Auto hide after 4 seconds

    // Refresh data lists
    updateMetrics();
    fetchTrending();
  } catch (error) {
    console.error('Error submitting search:', error);
  }
}

// ----------------------------------------------------
// 3. Trending List Board
// ----------------------------------------------------

async function fetchTrending() {
  try {
    const response = await fetch('/trending');
    const data = await response.json();
    
    trendingList.innerHTML = '';
    const trending = data.trending || [];
    
    if (trending.length === 0) {
      trendingList.innerHTML = `<div class="trending-row" style="color:var(--text-muted); font-style:italic; justify-content:center;">No recent trending searches. Click 'Simulate 100 Searches' below.</div>`;
      return;
    }

    trending.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'trending-row';
      row.innerHTML = `
        <span class="trending-num">${index + 1}</span>
        <span class="trending-query">${item.query}</span>
        <span class="trending-count">${item.trend_count}</span>
      `;
      row.addEventListener('click', () => {
        searchInput.value = item.query;
        submitSearch(item.query);
      });
      trendingList.appendChild(row);
    });
  } catch (error) {
    console.error('Error fetching trending list:', error);
  }
}

// ----------------------------------------------------
// 4. Collapsible Diagnostics Dashboard Panel
// ----------------------------------------------------

toggleDiagnosticsBtn.addEventListener('click', () => {
  const isHidden = diagnosticsPanel.classList.contains('hidden');
  if (isHidden) {
    diagnosticsPanel.classList.remove('hidden');
    toggleDiagnosticsBtn.textContent = '⚙️ Hide Diagnostics Panel';
    updateMetrics();
  } else {
    diagnosticsPanel.classList.add('hidden');
    toggleDiagnosticsBtn.textContent = '⚙️ Show Diagnostics Panel';
  }
});

async function updateMetrics() {
  // Only execute pull if diagnostics panel is currently expanded
  if (diagnosticsPanel.classList.contains('hidden')) return;

  try {
    const response = await fetch('/metrics');
    const data = await response.json();

    p50Val.textContent = data.latency.p50Ms;
    p95Val.textContent = data.latency.p95Ms;
    hitrateVal.textContent = data.cache.globalHitRate;
    writesSavedVal.textContent = data.writes.dbWritesSaved;
    reductionVal.textContent = data.writes.reductionRate;
    bufferVal.textContent = data.writes.pendingInBuffer;

    // Render shards list
    nodesList.innerHTML = '';
    const nodes = data.cache.nodes;
    
    Object.keys(nodes).forEach(nodeName => {
      const node = nodes[nodeName];
      const shardName = getShardName(nodeName);
      const row = document.createElement('div');
      row.className = 'node-row-item';
      row.innerHTML = `
        <span>${shardName} (${node.size} keys):</span>
        <strong>Hit Rate: ${node.hitRate}</strong>
      `;
      nodesList.appendChild(row);
    });

  } catch (error) {
    console.error('Error fetching metrics:', error);
  }
}

// ----------------------------------------------------
// 5. Diagnostics Hash Debugger
// ----------------------------------------------------

async function inspectKey() {
  const prefix = debugPrefixInput.value.trim();
  if (!prefix) return;

  const mode = rankingModeSelect.value;
  try {
    const response = await fetch(`/cache/debug?prefix=${encodeURIComponent(prefix)}&mode=${mode}`);
    const data = await response.json();

    debugNode.textContent = getShardName(data.responsibleNode);
    debugHash.textContent = data.keyHash.toLocaleString();
    debugCached.textContent = data.isCached ? 'HIT' : 'MISS';
    debugCached.className = data.isCached ? 'font-green' : 'font-danger';
    
    debugResult.classList.remove('hidden');
  } catch (error) {
    console.error('Error in key debug:', error);
  }
}

// ----------------------------------------------------
// 6. Diagnostics Engine Configurations
// ----------------------------------------------------

async function applyConfig(e) {
  e.preventDefault();

  const payload = {
    batchFlushIntervalMs: parseInt(batchIntervalInput.value, 10),
    batchSizeLimit: parseInt(batchLimitInput.value, 10)
  };

  try {
    await fetch('/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    alert('Engine configurations updated successfully!');
    updateMetrics();
  } catch (error) {
    console.error(error);
  }
}

async function flushBuffer() {
  await fetch('/batch/flush', { method: 'POST' });
  updateMetrics();
  fetchTrending();
}

async function clearCache() {
  await fetch('/cache/clear', { method: 'POST' });
  updateMetrics();
}

function simulateTraffic() {
  btnLoadTest.disabled = true;
  btnLoadTest.textContent = 'Simulating...';

  let count = 0;
  const interval = setInterval(async () => {
    const randQuery = SIMULATION_QUERIES[Math.floor(Math.random() * SIMULATION_QUERIES.length)];
    
    fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: randQuery })
    }).catch(() => {});

    count++;
    if (count >= 100) {
      clearInterval(interval);
      setTimeout(() => {
        btnLoadTest.disabled = false;
        btnLoadTest.textContent = '📈 Simulate 100 Searches';
        updateMetrics();
        fetchTrending();
      }, 600);
    }
  }, 20);
}

// ----------------------------------------------------
// 7. Event Bindings & Initializer
// ----------------------------------------------------

searchInput.addEventListener('input', (e) => {
  const val = e.target.value;
  if (val === lastInputVal) return;
  lastInputVal = val;
  debouncedFetch(val);
});

searchInput.addEventListener('keydown', (e) => {
  if (suggestionsContainer.classList.contains('hidden') || currentSuggestions.length === 0) {
    if (e.key === 'Enter') {
      submitSearch(searchInput.value);
    }
    return;
  }

  switch(e.key) {
    case 'ArrowDown':
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % currentSuggestions.length;
      setHighlight(selectedIndex);
      break;
    case 'ArrowUp':
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + currentSuggestions.length) % currentSuggestions.length;
      setHighlight(selectedIndex);
      break;
    case 'Enter':
      e.preventDefault();
      if (selectedIndex >= 0 && selectedIndex < currentSuggestions.length) {
        const selectedQuery = currentSuggestions[selectedIndex].query;
        searchInput.value = selectedQuery;
        submitSearch(selectedQuery);
      } else {
        submitSearch(searchInput.value);
      }
      break;
    case 'Escape':
      suggestionsContainer.classList.add('hidden');
      trendingContainer.classList.remove('hidden');
      break;
  }
});

// Close search response banner
responseClose.addEventListener('click', () => {
  searchResponsePanel.classList.add('hidden');
});

debugBtn.addEventListener('click', inspectKey);
debugPrefixInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') inspectKey();
});

configForm.addEventListener('submit', applyConfig);
btnFlush.addEventListener('click', flushBuffer);
btnClearCache.addEventListener('click', clearCache);
btnLoadTest.addEventListener('click', simulateTraffic);

// Debounce helper
function debounce(func, delay) {
  let timeout;
  return function (...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), delay);
  };
}

// Initial Invocations
fetchTrending();
// Poll trending board every 5 seconds to show surging searches
setInterval(fetchTrending, 5000);
// Periodically fetch diagnostics dashboard metrics if it's open
setInterval(updateMetrics, 3000);
