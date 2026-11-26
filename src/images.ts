// รูปจากกล้อง ณ เวลาที่เกิด event: SEMA ส่งขึ้นมา, เก็บใน R2 (aaa-images, private, ลบอัตโนมัติ 90 วัน)
// ดูได้ผ่าน Worker เท่านั้น: Admin (JWT) หรือลิงก์ที่เซ็นแล้ว (สำหรับ CSV) ไม่เปิด URL ตรงของ R2
import { hmacHex, safeEqual } from "./crypto";
import { json } from "./http";

export const IMAGE_KINDS = ["scene", "plate"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
const COLUMN: Record<ImageKind, string> = { scene: "image_url", plate: "plate_image_key" };
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const SIGNED_LINK_TTL_SEC = 7 * 86_400;

export const isImageKind = (v: unknown): v is ImageKind => (IMAGE_KINDS as readonly unknown[]).includes(v);

// PUT /api/v1/access/events/:event_id/image?kind=scene|plate  (Device JWT, body = JPEG ≤ 2 MB)
// event ต้องถูกบันทึกแล้วจาก /access/authorize ของอุปกรณ์ในโครงการเดียวกัน; ส่งซ้ำ = แทนที่รูปเดิม
export async function uploadEventImage(req: Request, env: Env, projectId: string, eventId: string, kind: unknown) {
	if (!isImageKind(kind)) return json({ error: "BAD_REQUEST", field: "kind" }, 400);
	if (!(req.headers.get("Content-Type") ?? "").startsWith("image/jpeg")) return json({ error: "UNSUPPORTED_MEDIA_TYPE" }, 415);
	const declared = Number(req.headers.get("Content-Length") ?? 0);
	if (declared > MAX_IMAGE_BYTES) return json({ error: "IMAGE_TOO_LARGE" }, 413);
	const bytes = new Uint8Array(await req.arrayBuffer());
	if (bytes.length > MAX_IMAGE_BYTES) return json({ error: "IMAGE_TOO_LARGE" }, 413);
	// JPEG เริ่มด้วย FF D8 FF
	if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return json({ error: "BAD_REQUEST", field: "body" }, 400);

	const log = await env.DB.prepare("SELECT timestamp FROM tb_access_log WHERE log_id = ? AND project_id = ?")
		.bind(eventId, projectId)
		.first<{ timestamp: string }>();
	if (!log) return json({ error: "EVENT_NOT_FOUND" }, 404);

	const key = `${projectId}/${String(log.timestamp).slice(0, 10)}/${eventId}-${kind}.jpg`;
	await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
	await env.DB.prepare(`UPDATE tb_access_log SET ${COLUMN[kind]} = ? WHERE log_id = ?`).bind(key, eventId).run();
	return json({ event_id: eventId, kind }, 201);
}

// ส่งรูปจาก R2; projectId = null สำหรับลิงก์ที่เซ็นแล้ว (log_id ไม่ซ้ำทั้งระบบ)
export async function readEventImage(env: Env, projectId: string | null, logId: string, kind: ImageKind) {
	const row = await env.DB.prepare(
		`SELECT ${COLUMN[kind]} AS k FROM tb_access_log WHERE log_id = ?${projectId === null ? "" : " AND project_id = ?"}`,
	)
		.bind(...(projectId === null ? [logId] : [logId, projectId]))
		.first<{ k: string | null }>();
	if (!row) return json({ error: "NOT_FOUND" }, 404);
	if (!row.k) return json({ error: "NO_IMAGE" }, 404);
	const obj = await env.IMAGES.get(row.k);
	// ลบตาม Lifecycle Rule แล้ว (เกิน 90 วัน)
	if (!obj) return json({ error: "IMAGE_EXPIRED" }, 404);
	return new Response(obj.body, {
		headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
	});
}

const signature = (env: Env, logId: string, kind: ImageKind, exp: number) => hmacHex(env.JWT_SECRET, `img:${logId}:${kind}:${exp}`);

/** ลิงก์ดูรูปที่หมดอายุเอง (ใช้ใน CSV ของรายงาน เปิดได้โดยไม่ต้อง login) */
export async function signedImageUrl(env: Env, origin: string, logId: string, kind: ImageKind) {
	const exp = Math.floor(Date.now() / 1000) + SIGNED_LINK_TTL_SEC;
	return `${origin}/api/v1/images/${encodeURIComponent(logId)}/${kind}?exp=${exp}&sig=${await signature(env, logId, kind, exp)}`;
}

// GET /api/v1/images/:log_id/:kind?exp=&sig=
export async function readSignedImage(env: Env, url: URL, logId: string, kind: string) {
	const exp = Number(url.searchParams.get("exp"));
	const sig = url.searchParams.get("sig") ?? "";
	if (!isImageKind(kind) || !Number.isInteger(exp) || exp < Date.now() / 1000) return json({ error: "LINK_EXPIRED" }, 403);
	if (!safeEqual(sig, await signature(env, logId, kind, exp))) return json({ error: "FORBIDDEN" }, 403);
	return readEventImage(env, null, logId, kind);
}
