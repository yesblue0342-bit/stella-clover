// api/workspace.js — Stella Workspace 백엔드 (PostgreSQL, ESM)
// ws_projects / ws_sessions / ws_notes 스키마는 _db.js getPool() 에서 1회 보장된다.
import { getPool, sql, hasDbConfig } from './_db.js';
import OpenAI from 'openai';
import { randomUUID } from 'crypto';

export const config = { maxDuration: 60 };

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function ok(res, data) {
  cors(res);
  return res.status(200).json({ ok: true, ...data });
}

function err(res, status, message) {
  cors(res);
  return res.status(status).json({ ok: false, message });
}

// 검색 스니펫: 키워드 주변 ~40자 발췌(공백 정리)
function snippetAround(text, q, ctx = 40) {
  const t = String(text || '');
  if (!t) return '';
  const i = t.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return t.slice(0, ctx * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, i - ctx), end = Math.min(t.length, i + q.length + ctx);
  return (start > 0 ? '…' : '') + t.slice(start, end).replace(/\s+/g, ' ').trim() + (end < t.length ? '…' : '');
}
// 채팅 메시지(JSON)에서 키워드 포함 첫 메시지의 스니펫
function chatSnippet(messagesJson, q) {
  let msgs = [];
  try { msgs = JSON.parse(messagesJson || '[]'); } catch (_) {}
  const ql = q.toLowerCase();
  for (const m of msgs) {
    const c = String((m && m.content) || '');
    if (c.toLowerCase().includes(ql)) return snippetAround(c, q);
  }
  return '';
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (!hasDbConfig()) return err(res, 200, 'DB 환경변수 미설정 (DATABASE_URL 또는 PGHOST 확인)');

  try {
    const pool = await getPool();

    // --- GET ---
    if (req.method === 'GET') {
      const { action, user, id } = req.query;

      if (action === 'all') {
        if (!user) return err(res, 400, 'user required');
        const [projects, sessions, notes] = await Promise.all([
          pool.request().input('u', sql.NVarChar, user)
            .query('SELECT id, user_id, name, color, created_at FROM ws_projects WHERE user_id=@u ORDER BY created_at ASC'),
          pool.request().input('u', sql.NVarChar, user)
            .query('SELECT id, user_id, project_id, title, msg_count, created_at, updated_at FROM ws_sessions WHERE user_id=@u ORDER BY updated_at DESC'),
          pool.request().input('u', sql.NVarChar, user)
            .query('SELECT id, user_id, title, content, created_at, updated_at FROM ws_notes WHERE user_id=@u ORDER BY updated_at DESC'),
        ]);
        return ok(res, {
          projects: projects.recordset,
          sessions: sessions.recordset,
          notes: notes.recordset,
        });
      }

      if (action === 'session') {
        if (!id || !user) return err(res, 400, 'id, user required');
        // 소유권 스코프: 본인(user_id) 세션만 조회 가능
        const r = await pool.request().input('id', sql.NVarChar, id).input('u', sql.NVarChar, user)
          .query('SELECT * FROM ws_sessions WHERE id=@id AND user_id=@u');
        if (!r.recordset.length) return err(res, 404, 'session not found');
        const s = r.recordset[0];
        let messages = [];
        try { messages = JSON.parse(s.messages || '[]'); } catch (_) {}
        return ok(res, { session: { ...s, messages } });
      }

      // 전역 검색: 채팅(제목+메시지 내용) + 노트(제목+내용). 본인(user_id) 데이터만.
      if (action === 'search') {
        if (!user) return err(res, 400, 'user required');
        const q = String(req.query.q || '').trim().slice(0, 100);
        if (!q) return ok(res, { results: [] });
        const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
        const [sessR, noteR] = await Promise.all([
          pool.request().input('u', sql.NVarChar, user).input('q', sql.NVarChar, like)
            .query(`SELECT id, title, msg_count, messages, updated_at FROM ws_sessions
                    WHERE user_id=@u AND (title ILIKE @q OR messages ILIKE @q)
                    ORDER BY updated_at DESC LIMIT 30`),
          pool.request().input('u', sql.NVarChar, user).input('q', sql.NVarChar, like)
            .query(`SELECT id, title, content, updated_at FROM ws_notes
                    WHERE user_id=@u AND (title ILIKE @q OR content ILIKE @q)
                    ORDER BY updated_at DESC LIMIT 30`),
        ]);
        const results = [];
        for (const s of sessR.recordset) {
          results.push({ type: 'chat', id: s.id, title: s.title || '새 채팅',
            snippet: chatSnippet(s.messages, q), meta: (s.msg_count || 0) + '개 메시지', ts: s.updated_at });
        }
        for (const n of noteR.recordset) {
          results.push({ type: 'note', id: n.id, title: n.title || '새 노트',
            snippet: snippetAround(n.content, q), meta: '노트', ts: n.updated_at });
        }
        results.sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
        return ok(res, { results });
      }

      return err(res, 400, 'unknown action');
    }

    // --- POST ---
    if (req.method === 'POST') {
      const body = req.body || {};
      const { action } = body;

      if (action === 'new_project') {
        const { user, name, color } = body;
        if (!user || !name) return err(res, 400, 'user, name required');
        const id = randomUUID();
        await pool.request()
          .input('id', sql.NVarChar, id)
          .input('u', sql.NVarChar, user)
          .input('n', sql.NVarChar, name.slice(0, 200))
          .input('c', sql.NVarChar, color || '#1a4731')
          .query('INSERT INTO ws_projects (id,user_id,name,color) VALUES (@id,@u,@n,@c)');
        return ok(res, { project: { id, user_id: user, name, color: color || '#1a4731' } });
      }

      if (action === 'new_session') {
        const { user, title } = body;
        if (!user) return err(res, 400, 'user required');
        // project_id 는 VARCHAR(36) → 초과 시 pg 22001(500) 방지 위해 길이 클램프
        const project_id = body.project_id ? String(body.project_id).slice(0, 36) : null;
        const id = randomUUID();
        await pool.request()
          .input('id', sql.NVarChar, id)
          .input('u', sql.NVarChar, user)
          .input('p', sql.NVarChar, project_id)
          .input('t', sql.NVarChar, (title || '새 채팅').slice(0, 500))
          .query('INSERT INTO ws_sessions (id,user_id,project_id,title) VALUES (@id,@u,@p,@t)');
        return ok(res, { session: { id, user_id: user, project_id, title: title || '새 채팅', messages: [], msg_count: 0 } });
      }

      if (action === 'new_note') {
        const { user, title, content } = body;
        if (!user) return err(res, 400, 'user required');
        const id = randomUUID();
        await pool.request()
          .input('id', sql.NVarChar, id)
          .input('u', sql.NVarChar, user)
          .input('t', sql.NVarChar, (title || '새 노트').slice(0, 500))
          .input('c', sql.NVarChar, content || '')
          .query('INSERT INTO ws_notes (id,user_id,title,content) VALUES (@id,@u,@t,@c)');
        return ok(res, { note: { id, user_id: user, title: title || '새 노트', content: content || '' } });
      }

      if (action === 'chat') {
        const { session_id, user } = body;
        const message = String(body.message || '').slice(0, 8000); // 비용/저장 폭증 방지
        if (!session_id || !user || !message) return err(res, 400, 'session_id, user, message required');
        if (!process.env.OPENAI_API_KEY) return err(res, 200, 'OpenAI API 키 미설정 (OPENAI_API_KEY 확인)');

        // 소유권 스코프: 본인 세션에만 채팅 가능
        const r = await pool.request().input('id', sql.NVarChar, session_id).input('u', sql.NVarChar, user)
          .query('SELECT * FROM ws_sessions WHERE id=@id AND user_id=@u');
        if (!r.recordset.length) return err(res, 404, 'session not found');

        const sess = r.recordset[0];
        let messages = [];
        try { messages = JSON.parse(sess.messages || '[]'); } catch (_) {}

        messages.push({ role: 'user', content: message });

        // GPT 호출
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: '당신은 Stella AI 어시스턴트입니다. 사용자를 친절하고 전문적으로 도와주세요. 한국어로 답변하세요.' },
            ...messages.slice(-20), // 최근 20개 메시지만 컨텍스트로 사용
          ],
          max_tokens: 2000,
          temperature: 0.7,
        });

        const reply = completion.choices[0]?.message?.content || '응답을 생성할 수 없습니다.';
        messages.push({ role: 'assistant', content: reply });

        // 제목 자동 설정 (첫 메시지이고 기본 제목인 경우)
        let newTitle = sess.title;
        if ((sess.title === '새 채팅' || !sess.title) && messages.filter(m => m.role === 'user').length === 1) {
          newTitle = message.slice(0, 50) + (message.length > 50 ? '...' : '');
        }

        const msgCount = messages.filter(m => m.role === 'user').length;
        const messagesJson = JSON.stringify(messages);

        await pool.request()
          .input('id', sql.NVarChar, session_id)
          .input('u', sql.NVarChar, user)
          .input('msgs', sql.NVarChar, messagesJson)
          .input('cnt', sql.Int, msgCount)
          .input('title', sql.NVarChar, newTitle)
          .query('UPDATE ws_sessions SET messages=@msgs, msg_count=@cnt, title=@title, updated_at=now() WHERE id=@id AND user_id=@u');

        return ok(res, { reply, title: newTitle, messages, msg_count: msgCount });
      }

      if (action === 'update_session') {
        const { id, user, title } = body;
        if (!id || !user) return err(res, 400, 'id, user required');
        await pool.request()
          .input('id', sql.NVarChar, id)
          .input('u', sql.NVarChar, user)
          .input('t', sql.NVarChar, (title || '').slice(0, 500))
          .query('UPDATE ws_sessions SET title=@t, updated_at=now() WHERE id=@id AND user_id=@u');
        return ok(res, {});
      }

      if (action === 'update_note') {
        const { id, user, title, content } = body;
        if (!id || !user) return err(res, 400, 'id, user required');
        await pool.request()
          .input('id', sql.NVarChar, id)
          .input('u', sql.NVarChar, user)
          .input('t', sql.NVarChar, (title || '').slice(0, 500))
          .input('c', sql.NVarChar, content || '')
          .query('UPDATE ws_notes SET title=@t, content=@c, updated_at=now() WHERE id=@id AND user_id=@u');
        return ok(res, {});
      }

      if (action === 'delete_session') {
        const { id, user } = body;
        if (!id || !user) return err(res, 400, 'id, user required');
        await pool.request()
          .input('id', sql.NVarChar, id)
          .input('u', sql.NVarChar, user)
          .query('DELETE FROM ws_sessions WHERE id=@id AND user_id=@u');
        return ok(res, {});
      }

      if (action === 'delete_note') {
        const { id, user } = body;
        if (!id || !user) return err(res, 400, 'id, user required');
        await pool.request()
          .input('id', sql.NVarChar, id)
          .input('u', sql.NVarChar, user)
          .query('DELETE FROM ws_notes WHERE id=@id AND user_id=@u');
        return ok(res, {});
      }

      if (action === 'delete_project') {
        const { id, user } = body;
        if (!id || !user) return err(res, 400, 'id, user required');
        // 세션 + 프로젝트 삭제를 한 트랜잭션으로 — 중간 실패 시 세션 고아 방지.
        const client = await pool._pg.connect();
        try {
          await client.query('BEGIN');
          await client.query('DELETE FROM ws_sessions WHERE project_id=$1 AND user_id=$2', [id, user]);
          await client.query('DELETE FROM ws_projects WHERE id=$1 AND user_id=$2', [id, user]);
          await client.query('COMMIT');
        } catch (e) {
          try { await client.query('ROLLBACK'); } catch (_) {}
          throw e;
        } finally {
          client.release();
        }
        return ok(res, {});
      }

      return err(res, 400, 'unknown action');
    }

    return err(res, 405, 'Method not allowed');
  } catch (e) {
    cors(res);
    console.error('[workspace]', e);
    return res.status(500).json({ ok: false, message: e.message || 'Internal server error' });
  }
}
