import { createSign } from "node:crypto";

// ---------------------------------------------------------------------------
// Google Drive: packing videos go into one folder in a shared drive.
//
// Set in Railway:
//   GOOGLE_SERVICE_ACCOUNT_JSON  the service account key (already there for email)
//   GOOGLE_DRIVE_FOLDER_ID       the folder's ID (the last part of its link)
// The folder must be in a shared drive, with the service account's email added
// to that shared drive as a Content manager (service accounts have no space of
// their own, so they can't upload to a My Drive).
//
// The browser uploads the video straight to Google: the server only starts a
// resumable upload and hands the camera window its address, so big files never
// pass through Railway.
// ---------------------------------------------------------------------------

const SCOPE = "https://www.googleapis.com/auth/drive";
const b64url = (buf) => Buffer.from(buf).toString("base64url");
let cached = null; // { token, expires }

function serviceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const key = JSON.parse(raw);
    if (!key.client_email || !key.private_key) return null;
    return { ...key, private_key: key.private_key.replace(/\\n/g, "\n") };
  } catch {
    return null;
  }
}

export const driveFolderId = () => {
  const v = String(process.env.GOOGLE_DRIVE_FOLDER_ID ?? "").trim();
  // A whole folder link pasted in: keep just the ID
  const m = v.match(/folders\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : v || null;
};

// What's missing, in plain words (null = ready)
export function driveSetupProblem() {
  if (!serviceAccount()) return "Add GOOGLE_SERVICE_ACCOUNT_JSON in Railway (the same service account key used for email).";
  if (!driveFolderId()) return "Add GOOGLE_DRIVE_FOLDER_ID in Railway: the ID of the shared drive folder for packing videos.";
  return null;
}
export const driveServiceEmail = () => serviceAccount()?.client_email ?? null;

async function token() {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const key = serviceAccount();
  if (!key) throw new Error(driveSetupProblem());
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description || body.error || `HTTP ${res.status}`}`);
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

// Starts a resumable upload. origin: the camera window's origin, so Google lets
// that page send the file (CORS). Returns the upload address.
// replaceId: an existing file to replace (same file and link, new video); if it's
// gone (deleted in Drive), a new file is made instead
export async function startDriveUpload({ name, mimeType, description, origin, replaceId = null }) {
  const problem = driveSetupProblem();
  if (problem) throw new Error(problem);
  const headers = {
    Authorization: `Bearer ${await token()}`,
    "Content-Type": "application/json; charset=UTF-8",
    "X-Upload-Content-Type": mimeType,
    ...(origin ? { Origin: origin } : {}),
  };
  const opts = "uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink";
  let res = null;
  if (replaceId) {
    res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(replaceId)}?${opts}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name, mimeType, description }),
    });
    if (res.status === 404) res = null; // deleted in Drive: make a new one
  }
  if (!res)
    res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?${opts}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, mimeType, parents: [driveFolderId()], description }),
    });
  const uploadUrl = res.headers.get("location");
  if (!res.ok || !uploadUrl) {
    const body = await res.json().catch(() => ({}));
    const why = body?.error?.message ?? `HTTP ${res.status}`;
    const hint = /not found|notFound/i.test(why)
      ? ` Check GOOGLE_DRIVE_FOLDER_ID, and that ${driveServiceEmail()} is a member of the shared drive.`
      : /storage quota|storageQuota/i.test(why)
        ? " The folder has to be in a shared drive (service accounts can't upload to a My Drive)."
        : "";
    throw new Error(`Google Drive refused the upload: ${why}.${hint}`);
  }
  return uploadUrl;
}

export const driveFileUrl = (id) => (id ? `https://drive.google.com/file/d/${id}/view` : null);
