import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import bot from "./bot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "botpult.db");
const HTML_PATH = path.join(__dirname, "index.html");

// Схема базы данных BotPult (6 таблиц)
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  chat_id INTEGER PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  joined_at INTEGER,
  source TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  funnel_paused INTEGER DEFAULT 0,
  last_message_at INTEGER DEFAULT 0,
  unread INTEGER DEFAULT 0,
  banned INTEGER DEFAULT 0,
  user_state TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER,
  sender TEXT,
  text TEXT,
  file_id TEXT,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS funnel_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT DEFAULT 'Шаг воронки',
  trigger_type TEXT DEFAULT 'button',
  trigger_value TEXT DEFAULT '',
  delay_days INTEGER DEFAULT 0,
  delay_hours INTEGER DEFAULT 0,
  delay_minutes INTEGER DEFAULT 0,
  msk_time TEXT DEFAULT '',
  text TEXT,
  file_id TEXT,
  media_type TEXT,
  buttons TEXT DEFAULT '[]',
  require_sub INTEGER DEFAULT 0,
  delete_prev INTEGER DEFAULT 0,
  fallback_cfg TEXT DEFAULT '',
  pos_x INTEGER DEFAULT 380,
  pos_y INTEGER DEFAULT 100
);

CREATE TABLE IF NOT EXISTS funnel_logs (
  chat_id INTEGER,
  step_id INTEGER,
  sent_at INTEGER,
  PRIMARY KEY (chat_id, step_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS consult_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_date TEXT,
  slot_time TEXT,
  slot_ts INTEGER,
  booked_by INTEGER DEFAULT NULL,
  client_name TEXT DEFAULT '',
  client_username TEXT DEFAULT '',
  client_phone TEXT DEFAULT '',
  booked_at INTEGER DEFAULT 0,
  reminded INTEGER DEFAULT 0,
  UNIQUE(slot_date, slot_time)
);
`;

// Инициализация локальной базы SQLite
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("synchronous = NORMAL");
sqlite.exec(SCHEMA_SQL);

function normalizeParam(val) {
  if (val === undefined) return null;
  if (typeof val === "boolean") return val ? 1 : 0;
  return val;
}

// Адаптер совместимости интерфейса Cloudflare D1 -> SQLite
function createD1Adapter(db) {
  function makeStatement(sql, boundParams = []) {
    const stmt = db.prepare(sql);
    const params = boundParams.map(normalizeParam);

    return {
      _sql: sql,
      _params: params,
      bind(...args) {
        return makeStatement(sql, args);
      },
      async all() {
        const results = stmt.all(...params);
        return { results, success: true, meta: {} };
      },
      async first(colName) {
        const row = stmt.get(...params);
        if (!row) return null;
        if (typeof colName === "string") {
          return Object.prototype.hasOwnProperty.call(row, colName) ? row[colName] : null;
        }
        return row;
      },
      async run() {
        const info = stmt.run(...params);
        return {
          success: true,
          meta: {
            last_row_id: Number(info.lastInsertRowid || 0),
            changes: Number(info.changes || 0),
          },
        };
      },
    };
  }

  return {
    prepare(sql) {
      return makeStatement(sql, []);
    },
    async batch(statements) {
      const runTx = db.transaction((items) => {
        const out = [];
        for (const item of items) {
          const st = db.prepare(item._sql);
          if (st.reader) {
            out.push({ results: st.all(...item._params), success: true, meta: {} });
          } else {
            const info = st.run(...item._params);
            out.push({
              results: [],
              success: true,
              meta: {
                last_row_id: Number(info.lastInsertRowid || 0),
                changes: Number(info.changes || 0),
              },
            });
          }
        }
        return out;
      });
      return runTx(statements);
    },
    async exec(sql) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
  };
}

const env = { DB: createD1Adapter(sqlite) };
const ctx = {
  waitUntil(promise) {
    Promise.resolve(promise).catch((err) => console.error("[waitUntil]", err));
  },
  passThroughOnException() {},
};

function getPreparedHtml() {
  const rawHtml = fs.readFileSync(HTML_PATH, "utf8");
  return rawHtml.replace(
    /const\s+API_URL\s*=\s*["'][^"']*["']\s*;/,
    "const API_URL = window.location.origin;"
  );
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const protoHeader = req.headers["x-forwarded-proto"];
    const proto = typeof protoHeader === "string" ? protoHeader.split(",")[0].trim() : "http";
    const hostHeader = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
    const fullUrl = `${proto}://${hostHeader}${req.url || "/"}`;
    const parsedUrl = new URL(fullUrl);

    // Раздача админ-панели по адресу /panel
    if (req.method === "GET" && (parsedUrl.pathname === "/panel" || parsedUrl.pathname === "/panel/")) {
      const html = getPreparedHtml();
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(html);
      return;
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) {
        for (const v of value) headers.append(key, v);
      } else if (typeof value === "string") {
        headers.set(key, value);
      }
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const bodyBuffer = hasBody ? await readRequestBody(req) : undefined;

    const webRequest = new Request(fullUrl, {
      method: req.method,
      headers,
      body: hasBody && bodyBuffer && bodyBuffer.length > 0 ? bodyBuffer : undefined,
    });

    const webResponse = await bot.fetch(webRequest, env, ctx);

    const outHeaders = {};
    webResponse.headers.forEach((value, key) => {
      outHeaders[key] = value;
    });

    res.writeHead(webResponse.status, outHeaders);
    const respArrayBuffer = await webResponse.arrayBuffer();
    res.end(Buffer.from(respArrayBuffer));
  } catch (err) {
    console.error("[HTTP Error]", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    }
    res.end(JSON.stringify({ ok: false, error: err?.message || "Internal Server Error" }));
  }
});

// Фоновый минутный планировщик для воронок и напоминаний
setInterval(async () => {
  if (typeof bot.scheduled === "function") {
    try {
      await bot.scheduled({ scheduledTime: Date.now(), cron: "* * * * *" }, env, ctx);
    } catch (err) {
      console.error("[Scheduler Error]", err);
    }
  }
}, 60 * 1000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`BotPult VPS server is running on port ${PORT}`);
  console.log(`Admin panel path: /panel`);
});