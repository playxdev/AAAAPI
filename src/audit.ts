// field ที่ห้ามลง audit log
const SECRET_FIELDS = new Set(["value", "password", "id_token", "link_code"]);

export type ActorType = "ADMIN" | "OWNER";

// บันทึกการเปลี่ยนแปลงข้อมูล ถ้าบันทึกไม่ได้จะ log error แต่ไม่ย้อนการกระทำที่สำเร็จไปแล้ว
export async function writeAudit(
	env: Env,
	projectId: string,
	actorType: ActorType,
	actorId: string,
	action: string,
	targetId: string | null,
	body: Record<string, unknown>,
) {
	const detail = Object.fromEntries(Object.entries(body).filter(([k]) => !SECRET_FIELDS.has(k)));
	try {
		await env.DB.prepare(
			"INSERT INTO tb_audit_log (project_id, actor_type, actor_id, action, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
		)
			.bind(projectId, actorType, actorId, action, targetId, JSON.stringify(detail))
			.run();
	} catch (err) {
		console.error("audit log failed", action, err);
	}
}

// target = :id ใน path หรือ *_id ตัวแรกใน response (กรณีสร้างใหม่)
export async function auditTarget(res: Response, pathId: string): Promise<string | null> {
	if (pathId) return pathId;
	try {
		const data = (await res.clone().json()) as Record<string, unknown>;
		const key = Object.keys(data).find((k) => k.endsWith("_id"));
		return key ? String(data[key]) : null;
	} catch {
		return null;
	}
}
