import { z } from "zod";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./activityStore.js";

const contactSchema = z.object({
    firstName: z.string().trim().min(1),
    lastName: z.string().trim().min(1),
    regionLabel: z
        .string()
        .trim()
        .regex(/^.+\(\+\d+\)$/),
    phone: z
        .string()
        .trim()
        .regex(/^\d{6,15}$/),
    // 保留既有格式規則，這次只替換驗證工具。
    email: z
        .string()
        .trim()
        .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
});

export type ContactDetails = z.infer<typeof contactSchema>;

const fieldMessages: Record<keyof ContactDetails, string> = {
    firstName: "請填寫名字。",
    lastName: "請填寫姓氏。",
    regionLabel: "區碼請使用完整選項文字，例如 台灣 (+886)。",
    phone: "手機號碼請填 6–15 位數字，區碼另行選擇。",
    email: "電子信箱格式不完整。",
};

export function validateContactDetails(value: unknown): ContactDetails {
    // 傳入資料，通過 zod 的型別檢驗
    const result = contactSchema.safeParse(value);
    // success 存在就回傳
    if (result.success) return result.data;

    // 只使用固定欄位提示，不傳遞 ZodError 或原始輸入值。
    const field = result.error.issues[0]?.path[0];
    // Object.hasOwn() 檢查物件是否有某個屬性
    // 大意上是，field 是字串，而且 fieldMessages 有 field, 就取出對應的提示
    const message =
        typeof field === "string" && Object.hasOwn(fieldMessages, field)
            ? fieldMessages[field as keyof ContactDetails]
            : "聯絡資料設定格式錯誤。";

    throw new Error(message);
}

// 個人資料是啟動前的必要設定；缺少資料時不開啟瀏覽器或選票。
export async function loadContactDetails(
    path: URL | string = new URL("../../contact.local.json", import.meta.url),
): Promise<ContactDetails> {
    let source: string;

    try {
        // 把個人資料讀取出來
        source = await readFile(path, "utf8");
    } catch (error) {
        // 缺檔也屬於準備失敗，提示補齊而不是進入個資頁才停止。
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new Error("缺少 contact.local.json，請依 contact.example.json 補齊個人資料後重新啟動；未開始購票。");
        }

        // 其他錯誤
        throw new Error("無法讀取 contact.local.json。");
    }

    let data: unknown;

    try {
        // 把資料轉成 JSON
        data = JSON.parse(source);
    } catch {
        throw new Error("contact.local.json 不是有效的 JSON，請檢查格式。");
    }

    return validateContactDetails(data);
}

// GUI 與 CLI 共用欄位規則。預設仍寫現有本機個資檔，不改範本。
export async function saveContactDetails(
    value: unknown,
    path = fileURLToPath(new URL("../../contact.local.json", import.meta.url)),
): Promise<void> {
    await writeJsonAtomic(path, validateContactDetails(value));
}
