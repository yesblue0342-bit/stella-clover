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

// 임의 이름의 Drive 최상위 폴더 보장(없으면 생성). rootName 기본 stellaclover.
async function getRoot(drive, rootName = CLOVER_FOLDER) {
  const q = `name='${esc(rootName)}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const r = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
  if (r.data.files?.[0]) return r.data.files[0].id;
  const c = await drive.files.create({ requestBody: { name: rootName, mimeType: FOLDER_MIME }, fields: "id" });
  return c.data.id;
}

// 경로 기반 폴더 보장: stellaclover/Meeting/2026/202606 → 최종 폴더 ID 반환
export async function ensurePath(drive, parts) {
  return ensurePathRooted(drive, CLOVER_FOLDER, parts);
}

// 임의 최상위 폴더를 루트로 경로 보장. 예) ensurePathRooted(drive,"stellagpt",["flow","20260628_1030_제목"])
//  → stellagpt/flow/20260628_1030_제목 폴더 ID. (Flow 결과를 stellaclover 가 아닌 stellagpt 하위에 저장)
export async function ensurePathRooted(drive, rootName, parts) {
  let p = await getRoot(drive, rootName);
  for (const part of parts.filter(Boolean)) p = await ensureFolder(drive, part, p);
  return p;
}

// Drive 폴더 웹 링크(공유/열람용). API 호출 없이 표준 폴더 URL 구성.
export function folderLink(folderId) {
  return folderId ? `https://drive.google.com/drive/folders/${folderId}` : null;
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

// 대용량 파일 스트리밍 업로드(원본 오디오 보관용 — RAM 에 통째로 올리지 않는다).
// bodyStream: fs.createReadStream 등. 반환: { id, webViewLink }.
export async function uploadFileStream(drive, folderId, fileName, mimeType, bodyStream) {
  const r = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body: bodyStream },
    fields: "id,webViewLink",
    supportsAllDrives: true,
  });
  return r.data;
}

// 파일 id로 원본 바이트 다운로드 (worker가 Drive에 올린 청크를 다시 받아 전사).
export async function downloadFileById(drive, fileId) {
  const r = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(r.data);
}

// 폴더 내 파일 하나를 이름으로 찾기(정확히 일치, 트래시 제외). 없으면 null.
async function findFileByName(drive, folderId, name) {
  const q = `name='${esc(name)}' and '${folderId}' in parents and trashed=false`;
  const r = await drive.files.list({ q, fields: "files(id)", pageSize: 1 });
  return r.data.files?.[0]?.id || null;
}

// JSON 객체를 폴더에 파일명으로 저장(같은 이름 파일이 있으면 내용 갱신, 없으면 새로 생성).
// savedAt 타임스탬프를 자동으로 덧붙인다(노트 등 Stella GPT와 공유하는 JSON 저장에 사용).
export async function saveJsonToDrive(drive, folderId, fileName, data) {
  const name = fileName.endsWith(".json") ? fileName : `${fileName}.json`;
  const body = JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2);
  const existingId = await findFileByName(drive, folderId, name);
  if (existingId) {
    await drive.files.update({
      fileId: existingId,
      media: { mimeType: "application/json", body: Readable.from([Buffer.from(body, "utf-8")]) },
    });
    return { id: existingId };
  }
  const r = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media: { mimeType: "application/json", body: Readable.from([Buffer.from(body, "utf-8")]) },
    fields: "id",
  });
  return { id: r.data.id };
}

// 폴더 내 .json 파일 목록(id, name) — 페이지네이션 처리.
export async function listJsonInFolder(drive, folderId) {
  const files = [];
  let pageToken;
  do {
    const r = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false and name contains '.json'`,
      fields: "nextPageToken, files(id,name)",
      pageSize: 100,
      pageToken,
    });
    files.push(...(r.data.files || []));
    pageToken = r.data.nextPageToken;
  } while (pageToken);
  return files;
}

// 파일 id의 내용을 JSON으로 파싱해 반환.
export async function readJsonById(drive, fileId) {
  const buf = await downloadFileById(drive, fileId);
  return JSON.parse(buf.toString("utf-8"));
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
