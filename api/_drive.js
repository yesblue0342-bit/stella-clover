// api/_drive.js - Google Drive 유틸 (stellaclover 전용, ESM 공유 모듈)
import { google } from "googleapis";
import { Readable } from "stream";

const CLOVER_FOLDER = "stellaclover";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export function getDrive() {
  const o = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  o.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: "v3", auth: o });
}

// Drive 검색 쿼리에서 작은따옴표 이스케이프 (폴더/파일명 인젝션 방지)
function esc(name) {
  return String(name).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function ensureFolder(drive, name, parentId) {
  const q = `name='${esc(name)}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`;
  const r = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
  if (r.data.files?.[0]) return r.data.files[0].id;
  const c = await drive.files.create({ requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] }, fields: "id" });
  return c.data.id;
}

async function getRoot(drive) {
  const q = `name='${esc(CLOVER_FOLDER)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const r = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
  if (r.data.files?.[0]) return r.data.files[0].id;
  const c = await drive.files.create({ requestBody: { name: CLOVER_FOLDER, mimeType: FOLDER_MIME }, fields: "id" });
  return c.data.id;
}

// 경로 기반 폴더 보장: stellaclover/Meeting/2026/202606 → 최종 폴더 ID 반환
export async function ensurePath(drive, parts) {
  let p = await getRoot(drive);
  for (const part of parts.filter(Boolean)) p = await ensureFolder(drive, part, p);
  return p;
}

export async function uploadText(drive, folderId, fileName, content) {
  const r = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType: "text/plain", body: Readable.from([Buffer.from(content, "utf-8")]) },
    fields: "id,webViewLink"
  });
  return r.data;
}

export async function uploadBuffer(drive, folderId, fileName, mimeType, buffer) {
  const r = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: Readable.from([buffer]) },
    fields: "id,webViewLink"
  });
  return r.data;
}

// 지정 폴더에서 modifiedTime이 cutoffIso 이전인 파일을 모두 삭제. 삭제 개수 반환.
export async function deleteOlderThan(drive, folderId, cutoffIso) {
  let deleted = 0, pageToken;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and modifiedTime < '${cutoffIso}'`,
      fields: "nextPageToken, files(id,name)",
      pageSize: 100,
      pageToken
    });
    for (const f of r.data.files || []) {
      await drive.files.delete({ fileId: f.id });
      deleted++;
    }
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return deleted;
}

// 텍스트 파일(회의록/전사)을 이름 또는 내용으로 검색
export async function searchText(drive, query, limit = 30) {
  const q = `(name contains '${esc(query)}' or fullText contains '${esc(query)}') and mimeType='text/plain' and trashed=false`;
  const r = await drive.files.list({
    q,
    fields: "files(id,name,webViewLink,modifiedTime,size)",
    orderBy: "modifiedTime desc",
    pageSize: Math.min(Math.max(1, limit), 100),
    spaces: "drive"
  });
  return r.data.files || [];
}

export function dateParts(now = new Date()) {
  const Y = now.getFullYear().toString();
  const YM = Y + String(now.getMonth() + 1).padStart(2, "0");
  const YMD = YM + String(now.getDate()).padStart(2, "0");
  const HM = String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
  return { Y, YM, YMD, HM };
}
