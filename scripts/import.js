const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sqlite3 = require('sqlite3').verbose();

const CSV_PATH = path.join(__dirname, '..', 'data', 'queries.csv');
const DB_PATH = path.join(__dirname, '..', 'typeahead.db');
const BATCH_SIZE = 5000;

function parseLine(line) {
  if (!line || line.trim() === '' || line.startsWith('query,count')) return null;

  // Handle double-quoted queries
  if (line.startsWith('"')) {
    const lastQuoteIndex = line.lastIndexOf('"');
    if (lastQuoteIndex > 0) {
      const query = line.substring(1, lastQuoteIndex).replace(/""/g, '"').trim();
      const countPart = line.substring(lastQuoteIndex + 2);
      const count = parseInt(countPart, 10) || 0;
      return { query, count };
    }
  }

  // Handle unquoted queries
  const commaIndex = line.lastIndexOf(',');
  if (commaIndex > 0) {
    const query = line.substring(0, commaIndex).trim();
    const count = parseInt(line.substring(commaIndex + 1), 10) || 0;
    return { query, count };
  }

  return null;
}

async function run() {
  console.log('--- Starting Dataset Import to SQLite ---');
  if (!fs.existsSync(CSV_PATH)) {
    console.error(`Error: Source dataset not found at ${CSV_PATH}`);
    process.exit(1);
  }

  // Remove existing database if any, to start fresh
  if (fs.existsSync(DB_PATH)) {
    console.log('Removing old database file...');
    fs.unlinkSync(DB_PATH);
  }

  const db = new sqlite3.Database(DB_PATH);

  // Enable WAL mode for performance
  db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
    
    // Create queries table
    db.run(`
      CREATE TABLE IF NOT EXISTS queries (
        query TEXT PRIMARY KEY,
        count INTEGER DEFAULT 0
      )
    `);

    // Create index on query for prefix matching
    db.run('CREATE INDEX IF NOT EXISTS idx_queries_query ON queries(query)');

    // Create recent_searches table for recency-aware ranking
    db.run(`
      CREATE TABLE IF NOT EXISTS recent_searches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);

    // Create index on recent_searches timestamp and query for fast sliding-window aggregation
    db.run('CREATE INDEX IF NOT EXISTS idx_recent_searches_ts ON recent_searches(timestamp)');
    db.run('CREATE INDEX IF NOT EXISTS idx_recent_searches_query ON recent_searches(query)');
  });

  const fileStream = fs.createReadStream(CSV_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let batch = [];
  let totalImported = 0;
  const startTime = Date.now();

  const insertBatch = (batchData) => {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        const stmt = db.prepare('INSERT OR REPLACE INTO queries (query, count) VALUES (?, ?)');
        
        for (const item of batchData) {
          stmt.run(item.query, item.count);
        }
        
        stmt.finalize();
        db.run('COMMIT', (err) => {
          if (err) {
            db.run('ROLLBACK');
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });
  };

  for await (const line of rl) {
    const parsed = parseLine(line);
    if (parsed) {
      batch.push(parsed);
      if (batch.length >= BATCH_SIZE) {
        await insertBatch(batch);
        totalImported += batch.length;
        console.log(`Imported ${totalImported.toLocaleString()} queries...`);
        batch = [];
      }
    }
  }

  // Insert remaining batch
  if (batch.length > 0) {
    await insertBatch(batch);
    totalImported += batch.length;
    batch = [];
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\nSuccess! Imported ${totalImported.toLocaleString()} records in ${duration} seconds.`);
  
  db.close((err) => {
    if (err) console.error(err);
    console.log('Database connection closed.');
  });
}

run().catch(console.error);
