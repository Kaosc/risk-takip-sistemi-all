import admin from "firebase-admin"
import { getAdminTokens, getUserTokenByUid } from "./utils"
import { COLLECTIONS } from "./contants"

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_KEY
	? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY)
	: require("../serviceAccountKey.json")

admin.initializeApp({
	credential: admin.credential.cert(serviceAccount),
})

const db = admin.firestore()
const messaging = admin.messaging()

const severityLabels: Record<string, string> = {
	low: "Düşük",
	medium: "Orta",
	high: "Yüksek",
	critical: "Kritik",
}

async function sendNotificationToTokens(
	tokens: string[],
	title: string,
	body: string,
	riskId: string,
	severity?: string,
): Promise<void> {
	if (tokens.length === 0) {
		console.log(`[BİLGİ] Geçerli FCM token bulunamadı, bildirim atlanıyor. (Risk ID: ${riskId})`)
		return
	}

	const chunkSize = 500

	for (let i = 0; i < tokens.length; i += chunkSize) {
		const chunk = tokens.slice(i, i + chunkSize)
		try {
			const result = await messaging.sendEachForMulticast({
				tokens: chunk,
				notification: { title, body },
				data: {
					riskId: String(riskId || ""),
					severity: String(severity || "low"),
					title: String(title),
					body: String(body),
				},
				android: {
					priority: "high",
				},
				apns: {
					payload: {
						aps: {
							contentAvailable: true,
						},
					},
				},
			})

			console.log(
				`✅ FCM Paketi Gönderildi -> Başarılı: ${result.successCount}, Başarısız: ${result.failureCount} (Risk ID: ${riskId})`,
			)
		} catch (err) {
			console.error("❌ FCM gönderim hatası:", err)
		}
	}
}

db.collection(COLLECTIONS.RISKS).onSnapshot(
	(snapshot) => {
		snapshot.docChanges().forEach(async (change) => {
			const riskId = change.doc.id
			const data = change.doc.data() as RiskDocument | undefined

			if (!data) return

			const afterStatus = data.status
			const afterSeverity = (data.severity as RiskSeverity) || "medium"
			const severityText = severityLabels[afterSeverity] || "Belirtilmedi"

			if (change.type === "added") {
				if (afterStatus === "new") {
					console.log(`[YENİ RİSK] ID: ${riskId} - Adminlere bildirim gönderiliyor...`)
					const adminTokens = await getAdminTokens()
					await sendNotificationToTokens(
						adminTokens,
						"Sisteme yeni risk eklendi",
						"Risk Derecesi: " + severityText,
						riskId,
						afterSeverity,
					)
				}
				return
			}
			// 2) Durum Güncellendiğinde (Status Changes)
			if (change.type === "modified") {
				if (afterStatus === "inprogress") {
					const assignedToken = await getUserTokenByUid(data.assignedToId)
					if (!assignedToken) {
						console.log(`[UYARI] Atanan personelin FCM tokenı yok. ID: ${data.assignedToId}`)
						return
					}

					await sendNotificationToTokens(
						[assignedToken],
						"Yeni Görev Ataması",
						"Risk Derecesi: " + severityText,
						riskId,
						afterSeverity,
					)
					return
				}

				if (afterStatus === "pendingVerification") {
					console.log(`[GÖREV TAMAMLANDI] ID: ${riskId} - Admin onayı bekleniyor.`)
					const adminTokens = await getAdminTokens()
					await sendNotificationToTokens(
						adminTokens,
						"Görev Tamamlandı",
						"Bir personel görevini tamamladı ve onayınızı bekliyor.",
						riskId,
						afterSeverity,
					)
					return
				}

				if (afterStatus === "completed") {
					const creatorToken = await getUserTokenByUid(data.createdBy)
					if (!creatorToken) {
						console.log(`[UYARI] Riski oluşturan kullanıcının FCM tokenı yok. ID: ${data.createdBy}`)
						return
					}

					await sendNotificationToTokens(
						[creatorToken],
						"Bildirim Kapatıldı",
						"Açtığınız risk bildirimi çözüldü ve onaylandı.",
						riskId,
						afterSeverity,
					)
				}
			}
		})
	},
	(error) => {
		console.error("❌ Firestore dinleme hatası:", error)
	},
)
