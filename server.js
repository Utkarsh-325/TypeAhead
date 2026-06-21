const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database Setup
const DB_PATH = path.join(__dirname, 'typeahead.db');
const db = new sqlite3.Database(DB_PATH);

// Settings (can be customized via settings API/UI)
const CONFIG = {
  batchFlushIntervalMs: 5000,
  batchSizeLimit: 50,
  recencyWeight: 10000,        // Score addition per recent search
  trendingWindowSec: 300,      // 5 minutes sliding window
  virtualNodesPerCache: 100,    // Nodes on hash ring
  cacheTTLMs: 60000            // 1 minute cache TTL
};

// Global system metrics
const metrics = {
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalSearchSubmissions: 0,
  databaseWriteTransactions: 0,
  p50LatencyMs: 0,
  p95LatencyMs: 0,
  latencies: [] // Circular buffer for latency tracking
};

function addLatency(ms) {
  metrics.latencies.push(ms);
  if (metrics.latencies.length > 1000) {
    metrics.latencies.shift();
  }
  // Recalculate p50 and p95
  const sorted = [...metrics.latencies].sort((a, b) => a - b);
  if (sorted.length > 0) {
    metrics.p50LatencyMs = sorted[Math.floor(sorted.length * 0.5)];
    metrics.p95LatencyMs = sorted[Math.floor(sorted.length * 0.95)];
  }
}

// ----------------------------------------------------
// 1. Consistent Hashing Ring Implementation
// ----------------------------------------------------
class ConsistentHashRing {
  constructor(virtualNodes = CONFIG.virtualNodesPerCache) {
    this.virtualNodes = virtualNodes;
    this.ring = new Map(); // Hash (int32) -> Node Name
    this.sortedHashes = []; // Sorted array of hashes
  }

  // Hash function (MD5 -> UInt32)
  hash(key) {
    const md5 = crypto.createHash('md5').update(key).digest();
    return md5.readUInt32BE(0);
  }

  addNode(nodeName) {
    for (let i = 0; i < this.virtualNodes; i++) {
      const vNodeKey = `${nodeName}-v${i}`;
      const vNodeHash = this.hash(vNodeKey);
      this.ring.set(vNodeHash, nodeName);
      this.sortedHashes.push(vNodeHash);
    }
    this.sortedHashes.sort((a, b) => a - b);
  }

  removeNode(nodeName) {
    for (let i = 0; i < this.virtualNodes; i++) {
      const vNodeKey = `${nodeName}-v${i}`;
      const vNodeHash = this.hash(vNodeKey);
      this.ring.delete(vNodeHash);
    }
    this.sortedHashes = this.sortedHashes.filter(h => this.ring.has(h));
  }

  getNode(key) {
    if (this.sortedHashes.length === 0) return null;
    const keyHash = this.hash(key);
    
    // Binary search for the first hash >= keyHash
    let low = 0;
    let high = this.sortedHashes.length - 1;
    let index = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (this.sortedHashes[mid] >= keyHash) {
        index = mid;
        high = mid - 1; // Keep looking left to find the absolute first >= keyHash
      } else {
        low = mid + 1;
      }
    }

    // Wrap around to start of the ring if no greater hash is found
    const targetHash = this.sortedHashes[index] >= keyHash 
      ? this.sortedHashes[index] 
      : this.sortedHashes[0];

    return {
      node: this.ring.get(targetHash),
      hash: keyHash,
      mappedHash: targetHash
    };
  }

  getRingInfo() {
    return this.sortedHashes.map(h => ({
      hash: h,
      node: this.ring.get(h)
    }));
  }
}

// ----------------------------------------------------
// 2. Cache Node Implementation (LRU & TTL)
// ----------------------------------------------------
class CacheNode {
  constructor(name, capacity = 1000) {
    this.name = name;
    this.capacity = capacity;
    this.store = new Map(); // key -> { value, expiresAt, lastAccessed }
    this.stats = {
      requests: 0,
      hits: 0,
      misses: 0
    };
  }

  get(key) {
    this.stats.requests++;
    const item = this.store.get(key);
    if (!item) {
      this.stats.misses++;
      return null;
    }

    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      this.stats.misses++;
      return null;
    }

    item.lastAccessed = Date.now();
    this.stats.hits++;
    return item.value;
  }

  set(key, value, ttl = CONFIG.cacheTTLMs) {
    // Evict if capacity reached (simple LRU eviction)
    if (this.store.size >= this.capacity) {
      let oldestKey = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.store.entries()) {
        if (v.lastAccessed < oldestTime) {
          oldestTime = v.lastAccessed;
          oldestKey = k;
        }
      }
      if (oldestKey) this.store.delete(oldestKey);
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttl,
      lastAccessed: Date.now()
    });
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
    this.stats.requests = 0;
    this.stats.hits = 0;
    this.stats.misses = 0;
  }
}

// Initialize Caches and Consistent Hash Ring
const cacheNodes = {
  'CacheNode-0': new CacheNode('CacheNode-0'),
  'CacheNode-1': new CacheNode('CacheNode-1'),
  'CacheNode-2': new CacheNode('CacheNode-2')
};

const hashRing = new ConsistentHashRing();
Object.keys(cacheNodes).forEach(node => hashRing.addNode(node));

// ----------------------------------------------------
// 3. Batch Write Buffer Setup
// ----------------------------------------------------
class BatchWriteBuffer {
  constructor() {
    this.buffer = new Map(); // query -> count increment
    this.recentSearches = []; // array of { query, timestamp } to insert
    this.flushTimeout = null;
  }

  addSearch(query) {
    const cleanQuery = query.trim().toLowerCase();
    if (!cleanQuery) return;

    // Increment aggregated count
    this.buffer.set(cleanQuery, (this.buffer.get(cleanQuery) || 0) + 1);

    // Record recent search event
    this.recentSearches.push({
      query: cleanQuery,
      timestamp: Date.now()
    });

    metrics.totalSearchSubmissions++;

    // Flush if size limit reached
    if (this.buffer.size >= CONFIG.batchSizeLimit) {
      this.flush();
    }
  }

  startScheduler() {
    if (this.flushTimeout) clearTimeout(this.flushTimeout);
    this.flushTimeout = setTimeout(() => {
      this.flush();
      this.startScheduler();
    }, CONFIG.batchFlushIntervalMs);
  }

  async flush() {
    if (this.buffer.size === 0) return;

    const currentBuffer = new Map(this.buffer);
    const currentRecent = [...this.recentSearches];

    this.buffer.clear();
    this.recentSearches = [];

    metrics.databaseWriteTransactions++;

    console.log(`[Batch Buffer] Flushing ${currentBuffer.size} aggregated queries (${currentRecent.length} raw searches) to SQLite.`);

    db.serialize(() => {
      db.run('BEGIN TRANSACTION');

      // 1. Bulk Upsert in Queries Table
      // If query exists, add the count. If not, insert it.
      const queryStmt = db.prepare(`
        INSERT INTO queries (query, count)
        VALUES (?, ?)
        ON CONFLICT(query) DO UPDATE SET count = count + excluded.count
      `);

      for (const [query, count] of currentBuffer.entries()) {
        queryStmt.run(query, count);
      }
      queryStmt.finalize();

      // 2. Insert Recent searches history log for trending calculation
      const historyStmt = db.prepare(`
        INSERT INTO recent_searches (query, timestamp)
        VALUES (?, ?)
      `);

      for (const event of currentRecent) {
        historyStmt.run(event.query, event.timestamp);
      }
      historyStmt.finalize();

      db.run('COMMIT', (err) => {
        if (err) {
          console.error('[Batch Buffer] Commit Failed, rolling back', err);
          db.run('ROLLBACK');
        } else {
          // Invalidate cache prefix keys affected by updates
          this.invalidateCacheForQueries(Array.from(currentBuffer.keys()));
        }
      });
    });
  }

  // Invalidate any cache prefix entries that map to the updated queries
  invalidateCacheForQueries(queries) {
    let invalidatedCount = 0;
    for (const query of queries) {
      // Invalidate prefixes from length 1 up to full query length
      for (let i = 1; i <= Math.min(query.length, 15); i++) {
        const prefix = query.substring(0, i);
        const { node } = hashRing.getNode(prefix);
        if (cacheNodes[node] && cacheNodes[node].delete(prefix)) {
          invalidatedCount++;
        }
      }
    }
    if (invalidatedCount > 0) {
      console.log(`[Cache Invalidation] Invalidated ${invalidatedCount} prefixes across cache nodes.`);
    }
  }

  getPendingCount() {
    return this.buffer.size;
  }
}

const batchBuffer = new BatchWriteBuffer();
batchBuffer.startScheduler();

// Periodically clean up old recent searches records (older than window size) to keep DB small
setInterval(() => {
  const expiryTimestamp = Date.now() - (CONFIG.trendingWindowSec * 1000);
  db.run('DELETE FROM recent_searches WHERE timestamp < ?', [expiryTimestamp], (err) => {
    if (err) console.error('Error pruning recent_searches:', err);
  });
}, 60000);

// ----------------------------------------------------
// 4. API Endpoint Handlers
// ----------------------------------------------------

// GET /suggest?q=<prefix>&mode=<basic|enhanced>
app.get('/suggest', (req, res) => {
  const startTime = Date.now();
  metrics.totalRequests++;

  const prefix = (req.query.q || '').trim().toLowerCase();
  const rankingMode = req.query.mode || 'basic'; // basic (count-based) vs enhanced (recency-based)

  // Use a cache key incorporating the prefix and mode
  const cacheKey = `${rankingMode}:${prefix}`;

  // Find routing cache node using consistent hashing
  const { node } = hashRing.getNode(cacheKey);
  const targetCache = cacheNodes[node];

  // Try to read from Cache Node
  const cachedData = targetCache.get(cacheKey);
  if (cachedData) {
    metrics.cacheHits++;
    const latency = Date.now() - startTime;
    addLatency(latency);
    return res.json({
      suggestions: cachedData,
      source: 'cache',
      cacheNode: node,
      latencyMs: latency
    });
  }

  // Cache Miss -> Read from SQLite Database
  metrics.cacheMisses++;

  const limit = 10;
  const recentCutoff = Date.now() - (CONFIG.trendingWindowSec * 1000);

  let sqlQuery = '';
  let params = [];

  if (rankingMode === 'enhanced') {
    // Recency-Aware Ranking Query:
    // Score = HistoricalCount + RecentSearchesCount * recencyWeight
    if (prefix === '') {
      sqlQuery = `
        SELECT q.query, (q.count + COALESCE(r.recent_count, 0) * ?) as score
        FROM queries q
        LEFT JOIN (
          SELECT query, COUNT(*) as recent_count
          FROM recent_searches
          WHERE timestamp >= ?
          GROUP BY query
        ) r ON q.query = r.query
        ORDER BY score DESC
        LIMIT ?
      `;
      params = [CONFIG.recencyWeight, recentCutoff, limit];
    } else {
      sqlQuery = `
        SELECT q.query, (q.count + COALESCE(r.recent_count, 0) * ?) as score
        FROM queries q
        LEFT JOIN (
          SELECT query, COUNT(*) as recent_count
          FROM recent_searches
          WHERE timestamp >= ?
          GROUP BY query
        ) r ON q.query = r.query
        WHERE q.query LIKE ?
        ORDER BY score DESC
        LIMIT ?
      `;
      params = [CONFIG.recencyWeight, recentCutoff, prefix + '%', limit];
    }
  } else {
    // Basic Popularity-based Sorting (historical counts)
    if (prefix === '') {
      sqlQuery = `
        SELECT query, count as score
        FROM queries
        ORDER BY count DESC
        LIMIT ?
      `;
      params = [limit];
    } else {
      sqlQuery = `
        SELECT query, count as score
        FROM queries
        WHERE query LIKE ?
        ORDER BY count DESC
        LIMIT ?
      `;
      params = [prefix + '%', limit];
    }
  }

  db.all(sqlQuery, params, (err, rows) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ error: 'Database search error' });
    }

    const suggestions = rows.map(r => ({ query: r.query, score: r.score }));

    // Populate Cache Node
    targetCache.set(cacheKey, suggestions);

    const latency = Date.now() - startTime;
    addLatency(latency);

    return res.json({
      suggestions,
      source: 'database',
      cacheNode: node,
      latencyMs: latency
    });
  });
});

// POST /search
app.post('/search', (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.trim() === '') {
    return res.status(400).json({ error: 'Invalid search query' });
  }

  // Queue to buffer
  batchBuffer.addSearch(query);

  return res.json({ message: 'Searched' });
});

// GET /cache/debug?prefix=<prefix>&mode=<basic|enhanced>
app.get('/cache/debug', (req, res) => {
  const prefix = (req.query.prefix || '').trim().toLowerCase();
  const rankingMode = req.query.mode || 'basic';
  const cacheKey = `${rankingMode}:${prefix}`;

  const routing = hashRing.getNode(cacheKey);
  if (!routing) {
    return res.status(500).json({ error: 'Hash ring uninitialized' });
  }

  const nodeName = routing.node;
  const targetCache = cacheNodes[nodeName];
  const item = targetCache.store.get(cacheKey);
  const isHit = item ? (Date.now() <= item.expiresAt) : false;

  return res.json({
    cacheKey,
    prefix,
    mode: rankingMode,
    responsibleNode: nodeName,
    keyHash: routing.hash,
    mappedVirtualNodeHash: routing.mappedHash,
    isCached: isHit,
    expiresInMs: isHit ? (item.expiresAt - Date.now()) : null,
    cachedValue: isHit ? item.value : null
  });
});

// GET /trending
// Dedicated API endpoint to return pure recent searches (trending queries in the window)
app.get('/trending', (req, res) => {
  const recentCutoff = Date.now() - (CONFIG.trendingWindowSec * 1000);
  
  db.all(`
    SELECT query, COUNT(*) as trend_count
    FROM recent_searches
    WHERE timestamp >= ?
    GROUP BY query
    ORDER BY trend_count DESC
    LIMIT 10
  `, [recentCutoff], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Failed to fetch trending searches' });
    }
    return res.json({ trending: rows });
  });
});

// GET /metrics
app.get('/metrics', (req, res) => {
  // Aggregate cache nodes info
  const nodeStats = {};
  Object.keys(cacheNodes).forEach(k => {
    nodeStats[k] = {
      capacity: cacheNodes[k].capacity,
      size: cacheNodes[k].store.size,
      requests: cacheNodes[k].stats.requests,
      hits: cacheNodes[k].stats.hits,
      misses: cacheNodes[k].stats.misses,
      hitRate: cacheNodes[k].stats.requests > 0 
        ? ((cacheNodes[k].stats.hits / cacheNodes[k].stats.requests) * 100).toFixed(1) + '%' 
        : '0%'
    };
  });

  const cacheRate = metrics.totalRequests > 0
    ? ((metrics.cacheHits / metrics.totalRequests) * 100).toFixed(1) + '%'
    : '0%';

  const dbWritesSaved = metrics.totalSearchSubmissions - metrics.databaseWriteTransactions;
  const writeReductionRate = metrics.totalSearchSubmissions > 0
    ? ((dbWritesSaved / metrics.totalSearchSubmissions) * 100).toFixed(1) + '%'
    : '0%';

  res.json({
    latency: {
      p50Ms: metrics.p50LatencyMs,
      p95Ms: metrics.p95LatencyMs,
      totalRequestsTracked: metrics.latencies.length
    },
    cache: {
      globalHitRate: cacheRate,
      globalHits: metrics.cacheHits,
      globalMisses: metrics.cacheMisses,
      nodes: nodeStats
    },
    writes: {
      totalSubmissions: metrics.totalSearchSubmissions,
      dbWritesExecuted: metrics.databaseWriteTransactions,
      dbWritesSaved: dbWritesSaved,
      reductionRate: writeReductionRate,
      pendingInBuffer: batchBuffer.getPendingCount()
    },
    config: CONFIG
  });
});

// POST /config - Customize config dynamically for demo tuning
app.post('/config', (req, res) => {
  const { batchFlushIntervalMs, batchSizeLimit, recencyWeight, trendingWindowSec, cacheTTLMs } = req.body;
  
  if (batchFlushIntervalMs !== undefined) CONFIG.batchFlushIntervalMs = Number(batchFlushIntervalMs);
  if (batchSizeLimit !== undefined) CONFIG.batchSizeLimit = Number(batchSizeLimit);
  if (recencyWeight !== undefined) CONFIG.recencyWeight = Number(recencyWeight);
  if (trendingWindowSec !== undefined) CONFIG.trendingWindowSec = Number(trendingWindowSec);
  if (cacheTTLMs !== undefined) CONFIG.cacheTTLMs = Number(cacheTTLMs);

  // Restart buffer scheduler if flush interval changed
  batchBuffer.startScheduler();

  return res.json({ message: 'Configuration updated successfully', config: CONFIG });
});

// POST /cache/clear - Clear all cache nodes
app.post('/cache/clear', (req, res) => {
  Object.keys(cacheNodes).forEach(k => cacheNodes[k].clear());
  metrics.cacheHits = 0;
  metrics.cacheMisses = 0;
  metrics.totalRequests = 0;
  return res.json({ message: 'All cache nodes cleared.' });
});

// POST /batch/flush - Force immediate flush of batch buffer
app.post('/batch/flush', (req, res) => {
  batchBuffer.flush();
  return res.json({ message: 'Batch write buffer flushed to SQLite database.' });
});

// GET /hashring - Debug view of ring topology
app.get('/hashring', (req, res) => {
  res.json({
    virtualNodesCount: hashRing.sortedHashes.length,
    ring: hashRing.sortedHashes.map(h => ({
      hash: h,
      node: hashRing.ring.get(h)
    }))
  });
});

// Error handling fallback
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Internal Server Error');
});

// Listen to port
app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`Typeahead Server running locally at http://localhost:${PORT}`);
  console.log(`Configuration:`);
  console.log(` - Batch Flush Interval: ${CONFIG.batchFlushIntervalMs} ms`);
  console.log(` - Batch Size Limit: ${CONFIG.batchSizeLimit}`);
  console.log(` - Recency Weight: ${CONFIG.recencyWeight}`);
  console.log(` - Trending sliding window: ${CONFIG.trendingWindowSec} s`);
  console.log(` - Cache TTL: ${CONFIG.cacheTTLMs} ms`);
  console.log(`======================================================\n`);
});
