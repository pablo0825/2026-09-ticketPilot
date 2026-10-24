import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { parseRunRecord, type RunRecord } from "./runRecord.js";

// 執行紀錄的磁碟讀寫。全部使用同步 API：啟動購票時，去重紀錄必須在啟動子程序前寫入，中間不能插入其他請求。
export class RunRecordStore {
    private readonly directory: string;

    constructor(root: string) {
        this.directory = join(root, "runs");
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    }

    // 讀取全部紀錄；封存平台的紀錄不回傳，檔案保持原樣。任何一筆無法讀取就停止。
    loadAll(): RunRecord[] {
        // 檔名規則同時排除寫入中斷留下的暫存檔
        const files = readdirSync(this.directory).filter(name => /^[0-9a-f-]{36}\.json$/.test(name));
        return files
            .map(name => this.read(name.slice(0, -5)))
            .filter((record): record is RunRecord => record !== undefined && record !== "archived-klook");
    }

    read(id: string): RunRecord | "archived-klook" | undefined {
        // 識別碼檢查也在 try 內，無效的識別碼一樣回報無法讀取。
        try {
            return parseRunRecord(JSON.parse(readFileSync(this.file(id), "utf8")), id);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw new Error("執行紀錄無法讀取，請先人工檢查。");
        }
    }

    // 識別碼無效時丟出錯誤，由呼叫端決定如何保守處理。
    exists(id: string): boolean {
        return existsSync(this.file(id));
    }

    // 只建立新檔；同一個請求的紀錄已存在時，原樣丟出檔案系統錯誤。
    create(record: RunRecord): void {
        writeFileSync(this.file(record.snapshot.requestId), JSON.stringify(record), { flag: "wx", mode: 0o600 });
    }

    // 先寫同資料夾的暫存檔再改名，避免中斷時留下寫到一半的紀錄。
    replace(record: RunRecord): void {
        const path = this.file(record.snapshot.requestId);
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
        renameSync(temporary, path);
    }

    private file(id: string): string {
        if (!z.string().uuid().safeParse(id).success) throw new Error("開始請求識別碼無效。");
        return join(this.directory, `${id}.json`);
    }
}
