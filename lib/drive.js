// lib/drive.js - Google Drive 유틸 (stellaclover 전용)
import { google } from "googleapis";

const CLOVER_FOLDER_NAME = "stellaclover";
const FOLDER_MIME = "application/vnd.google-apps.folder";

function getAuth() {
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2;
}

export function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

// 폴더 찾기 or 생성
async function ensureFolder(name, parentId) {
  const drive = getDrive();
  const q = `name='${name}' and mimeType='${FOLDER_MIME}' and '${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({ q, fields: "files(id,name)", pageSize: 1 });
  if (res.data.files?.[0]) return res.data.files[0];
  const created = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
    fields: "id,name"
  });
  return created.data;
}

// stellaclover 루트 폴더 ID 가져오기
async function getCloverRoot() {
  const drive = getDrive();
  const q = `name='${CLOVER_FOLDER_NAME}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  const res = await drive.files.list({ q, fields: "files(id,name)", pageSize: 1 });
  if (res.data.files?.[0]) return res.data.files[0].id;
  const created = await drive.files.create({
    requestBody: { name: CLOVER_FOLDER_NAME, mimeType: FOLDER_MIME },
    fields: "id"
  });
  return created.data.id;
}

// 경로 기반 폴더 보장: stellaclover/Meeting/2026/202606
export async function ensurePath(parts) {
  let parentId = await getCloverRoot();
  let folder = { id: parentId };
  for (const part of parts.filter(Boolean)) {
    folder = await ensureFolder(part, parentId);
    parentId = folder.id;
  }
  return folder;
}

// 파일 업로드
export async function uploadToDrive({ folderId, fileName, mimeType, content }) {
  const drive = getDrive();
  const { Readable } = await import("stream");
  const body = typeof content === "string"
    ? Readable.from([Buffer.from(content, "utf-8")])
    : Readable.from([content]);

  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [folderId] },
    media: { mimeType, body },
    fields: "id,webViewLink"
  });
  return res.data;
}

// 날짜 경로 생성
export function dateParts() {
  const now = new Date();
  const Y = now.getFullYear().toString();
  const YM = Y + String(now.getMonth() + 1).padStart(2, "0");
  const YMD = YM + String(now.getDate()).padStart(2, "0");
  const HM = String(now.getHours()).padStart(2, "0") + String(now.getMinutes()).padStart(2, "0");
  return { Y, YM, YMD, HM };
}
