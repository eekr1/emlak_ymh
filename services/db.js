import pkg from "pg";
const { Pool } = pkg;
import { DATABASE_URL } from "../config/env.js";

export const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false } // Render gibi managed DB'lerde güvenli
    : false,
});

export async function ensureTables() {
  if (!DATABASE_URL) {
    console.warn("[db] DATABASE_URL yok — loglama devre dışı.");
    return;
  }

  try {
    // 1) Tabloları oluştur (kolonlar burada olsa da olur; ama minimal tutup garantiye alıyoruz)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id SERIAL PRIMARY KEY,
        thread_id TEXT UNIQUE NOT NULL,
        brand_key TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        last_message_at TIMESTAMPTZ DEFAULT now()
      );

     CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  text TEXT,
  raw_text TEXT,
  handoff_kind TEXT,
  handoff_payload JSONB,
  meta JSONB,
  transaction_type TEXT,
  property_type TEXT,
  location TEXT,
  budget TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

    `);

    // 2) Kolonları garanti et (idempotent migration)
    await pool.query(`
      ALTER TABLE conversations
        ADD COLUMN IF NOT EXISTS visitor_id TEXT,
        ADD COLUMN IF NOT EXISTS session_id TEXT,
        ADD COLUMN IF NOT EXISTS source JSONB;

      ALTER TABLE messages
        ADD COLUMN IF NOT EXISTS meta JSONB,
        ADD COLUMN IF NOT EXISTS admin_status TEXT DEFAULT 'NEW',
        ADD COLUMN IF NOT EXISTS admin_notes TEXT,
        ADD COLUMN IF NOT EXISTS budget TEXT,
        ADD COLUMN IF NOT EXISTS transaction_type TEXT,
        ADD COLUMN IF NOT EXISTS property_type TEXT,
        ADD COLUMN IF NOT EXISTS location TEXT;
    `);

    // 3) Index’leri garanti et (kolonlar artık kesin var)
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_thread_id
        ON conversations(thread_id);

      CREATE INDEX IF NOT EXISTS idx_conversations_brand_key
        ON conversations(brand_key);

      CREATE INDEX IF NOT EXISTS idx_conversations_visitor_id
        ON conversations(visitor_id);

      CREATE INDEX IF NOT EXISTS idx_conversations_session_id
        ON conversations(session_id);

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
        ON messages(conversation_id);

      -- SOURCES (Web Knowledge Base)
      CREATE TABLE IF NOT EXISTS sources (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          brand_key TEXT NOT NULL,
          url TEXT NOT NULL,
          status TEXT DEFAULT 'idle', -- 'idle', 'indexing', 'error'
          last_indexed_at TIMESTAMPTZ,
          last_error TEXT,
          created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS source_chunks (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          source_id UUID REFERENCES sources(id) ON DELETE CASCADE,
          brand_key TEXT NOT NULL,
          content TEXT,
          created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS source_embeddings (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          chunk_id UUID REFERENCES source_chunks(id) ON DELETE CASCADE,
          brand_key TEXT NOT NULL,
          embedding JSONB, -- store as array for now, can be vector(1536) if pgvector enabled
          created_at TIMESTAMPTZ DEFAULT now()
      );

      -- 4) Schema Migration (Yeni kolonlar)
      ALTER TABLE sources
        ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN DEFAULT true;
    `);

    console.log("[db] tablo kontrolü / migration / index tamam ✅");
  } catch (e) {
    console.error("[db] ensureTables hata:", e);
  }
}

export async function logChatMessage({
  brandKey,
  threadId,
  role,
  text,
  rawText,
  handoff,
  visitorId,
  sessionId,
  source,
  meta
}) {
  if (!DATABASE_URL) return;

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 1) Konuşmayı upsert et (thread_id unique)
      // ✅ NEW: visitor/session bilgileri varsa conversations'a yaz / güncelle
      const convRes = await client.query(
        `
  INSERT INTO conversations (thread_id, brand_key, visitor_id, session_id, source, created_at, last_message_at)
  VALUES ($1, $2, $3, $4, $5, now(), now())
  ON CONFLICT (thread_id)
  DO UPDATE SET
    brand_key = EXCLUDED.brand_key,
    last_message_at = now(),
    visitor_id = COALESCE(conversations.visitor_id, EXCLUDED.visitor_id),
    session_id = COALESCE(conversations.session_id, EXCLUDED.session_id),
    source = COALESCE(conversations.source, EXCLUDED.source)
  RETURNING id
  `,
        [threadId, brandKey || null, visitorId || null, sessionId || null, source ? JSON.stringify(source) : null]
      );


      const conversationId = convRes.rows[0].id;

      // Extract property details if available
      const pd = handoff?.payload?.property_details || {};
      const tType = pd.transaction_type || null;
      const pType = pd.property_type || null;
      const loc = pd.location || null;
      const bud = pd.budget || null;

      // 2) Mesajı ekle
      await client.query(
        `
  INSERT INTO messages
    (conversation_id, role, text, raw_text, handoff_kind, handoff_payload, meta, transaction_type, property_type, location, budget, created_at)
  VALUES
    ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
  `,
        [
          conversationId,
          role,
          text || null,
          rawText || null,
          handoff ? handoff.kind || null : null,
          handoff ? JSON.stringify(handoff.payload || null) : null,
          meta ? JSON.stringify(meta) : null,
          tType,
          pType,
          loc,
          bud
        ]
      );


      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[db] logChatMessage transaction error:", e);
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("[db] connection error:", e);
  }
}

/* ================== VECTOR SEARCH (Memory-based Fallback) ================== */

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    magnitudeA += vecA[i] * vecA[i];
    magnitudeB += vecB[i] * vecB[i];
  }
  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);
  return (magnitudeA && magnitudeB) ? dotProduct / (magnitudeA * magnitudeB) : 0;
}

export async function searchVectors(brandKey, queryEmbedding, limit = 5) {
  const client = await pool.connect();
  try {
    // 1. Fetch ALL embeddings for this brand
    // Note: If data grows large, this will be slow. Move to pgvector later.
    const res = await client.query(`
      SELECT
        se.embedding,
        sc.content,
        s.url
      FROM source_embeddings se
      JOIN source_chunks sc ON se.chunk_id = sc.id
      JOIN sources s ON sc.source_id = s.id
      WHERE s.brand_key = $1
    `, [brandKey]);

    // 2. Calculate similarity in memory
    const candidates = res.rows.map(row => {
      // Postgres JSONB array comes back as standard JS array
      const embedding = row.embedding;
      const score = cosineSimilarity(queryEmbedding, embedding);
      return { ...row, score };
    });

    // 3. Sort by score (descending) & Slice
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, limit);

    /* ================== SOURCES (Admin) ================== */

    // ensureTables içinde şema update için "ALTER TABLE..." ekledik;
    // aşağıda da fonksiyonları implemente ediyoruz.

    export async function getSources(brandKey) {
      const client = await pool.connect();
      try {
        const res = await client.query(`
      SELECT * FROM sources
      WHERE brand_key = $1
      ORDER BY created_at DESC
    `, [brandKey]);
        return res.rows;
      } finally {
        client.release();
      }
    }

    export async function getSourceById(id) {
      const client = await pool.connect();
      try {
        const res = await client.query(`SELECT * FROM sources WHERE id = $1`, [id]);
        return res.rows[0] || null;
      } finally {
        client.release();
      }
    }

    export async function addSource({ brandKey, url }) {
      const client = await pool.connect();
      try {
        const res = await client.query(`
      INSERT INTO sources (brand_key, url, status)
      VALUES ($1, $2, 'idle')
      RETURNING *
    `, [brandKey, url]);
        return res.rows[0];
      } finally {
        client.release();
      }
    }

    export async function toggleSource(id, enabled) {
      const client = await pool.connect();
      try {
        const res = await client.query(`
      UPDATE sources
      SET is_enabled = $2
      WHERE id = $1
      RETURNING *
    `, [id, enabled]);
        return res.rows[0];
      } finally {
        client.release();
      }
    }

    export async function updateSourceStatus(id, { status, last_error }) {
      const client = await pool.connect();
      try {
        // Dinamik set oluşturma (basit versiyon)
        const fields = [];
        const values = [];
        let idx = 1;

        if (status !== undefined) {
          fields.push(`status = $${idx++}`);
          values.push(status);
        }
        if (last_error !== undefined) {
          fields.push(`last_error = $${idx++}`);
          values.push(last_error);
        }
        // Her güncellemede timestamp yenilemek istersen:
        // fields.push(`last_indexed_at = now()`); 
        // Ama belki status 'idle' olunca değil, 'indexed' olunca? Senaryoya göre değişir.

        if (fields.length === 0) return null;

        values.push(id);
        const sql = `
      UPDATE sources
      SET ${fields.join(", ")}
      WHERE id = $${idx}
      RETURNING *
    `;
        const res = await client.query(sql, values);
        return res.rows[0];
      } finally {
        client.release();
      }
    }

    export async function deleteSource(id) {
      const client = await pool.connect();
      try {
        // source_chunks ve embeddings CASCADE ile silinir (tablo tanımında ON DELETE CASCADE varsa).
        // Emin olmak için ensureTables'a bak: "REFERENCES sources(id) ON DELETE CASCADE" var.
        await client.query(`DELETE FROM sources WHERE id = $1`, [id]);
        return true;
      } finally {
        client.release();
      }
    }

    export async function clearSourceChunks(sourceId) {
      const client = await pool.connect();
      try {
        await client.query(`DELETE FROM source_chunks WHERE source_id = $1`, [sourceId]);
        return true;
      } finally {
        client.release();
      }
    }

    export async function saveSourceChunks(sourceId, chunks) {
      // chunks: [{ content, embedding: [...] }, ...]
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // 1. Chunk'ları ve embeddingleri ekle
        // Performans için loop ile yapıyoruz, çok büyükse bulk insert gerekir.
        for (const chunk of chunks) {
          const cRes = await client.query(`
        INSERT INTO source_chunks (source_id, brand_key, content)
        VALUES ($1, $2, $3)
        RETURNING id, brand_key
      `, [sourceId, chunk.brand_key || 'unknown', chunk.content]); // brand_key chunk içinde gelmeli veya parametre olmalı

          const chunkId = cRes.rows[0].id;
          const bKey = cRes.rows[0].brand_key;

          if (chunk.embedding) {
            await client.query(`
            INSERT INTO source_embeddings (chunk_id, brand_key, embedding)
            VALUES ($1, $2, $3)
          `, [chunkId, bKey, JSON.stringify(chunk.embedding)]);
          }
        }

        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    }

