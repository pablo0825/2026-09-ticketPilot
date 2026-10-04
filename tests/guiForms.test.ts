import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { ActivityStore } from "../src/config/activityStore.js";
import { startLocalServer } from "../src/local/server.js";

test("完整GUI：設定保存、個資未存阻擋、模擬與實際fixture、重連保留真實結果",async()=>{
    const dir=await mkdtemp(join(tmpdir(),'ticket-gui-'));
    const store = new ActivityStore(join(dir,'events'));
    const service=await startLocalServer(store,{contactPath:join(dir,'contact.json'),runDirectory:join(dir,'runtime'),purchaseWorker:new URL('./fixtures/guiPurchaseWorker.ts',import.meta.url)});
    const browser=await chromium.launch();
    try{
        const page=await browser.newPage();await page.goto(service.url);
        await page.locator("#new").click();
        await page.locator('#eventName').fill('UNKNOWN');await page.locator('#eventUrl').fill('https://www.klook.com/zh-TW/event-detail/fixture/');
        await page.locator('[name=date]').fill('2026-11-02');await page.locator('[name=time]').fill('19:30');await page.locator('[name=area]').fill('B區');await page.locator('[name=unitPrice]').fill('5280');
        await page.getByRole('button',{name:'儲存活動，下一步'}).click();await page.locator('#firstName').fill('Demo');await page.locator('#lastName').fill('Test');await page.locator('#phone').fill('0912345678');await page.locator('#email').fill('demo@example.com');
        await page.getByRole('button',{name:'儲存設定，檢查摘要'}).click();await page.locator('#summary').filter({hasText:'B區'}).waitFor();
        await page.locator('#confirm').check();assert(await page.locator('#start').isEnabled());
        await page.getByRole('button',{name:'② 個資與時間'}).click();await page.locator('#phone').fill('0999999999');
        await page.getByRole('button',{name:'① 活動與順位'}).click();await page.getByRole('button',{name:'儲存變更，下一步'}).click();
        await page.getByRole('button',{name:'③ 執行狀態'}).click();await page.locator('#confirm').check();assert(await page.locator('#start').isDisabled());
        await page.getByRole('button',{name:'② 個資與時間'}).click();
        let releaseSave: () => void = () => {};
        const saveGate = new Promise<void>(resolve => releaseSave = resolve);
        let receivedSave: () => void = () => {};
        const saveReceived = new Promise<void>(resolve => receivedSave = resolve);
        await page.route('**/api/contact', async route => {
            if (route.request().method() === 'PUT') {
                receivedSave();
                await saveGate;
            }
            await route.continue();
        });
        await page.getByRole('button',{name:'儲存設定，檢查摘要'}).click();
        await saveReceived;
        assert(await page.locator('#phone').isDisabled());
        assert(await page.locator('#homeButton').isDisabled());
        releaseSave();
        await page.locator('#simulate').waitFor({state:'visible'});
        await page.locator('#simulate').click();
        await page.locator('#homeButton').click();
        await page.locator('#viewRun').filter({hasText:'查看模擬紀錄'}).click();
        await page.getByText('模擬完成（未購票）',{exact:true}).waitFor();
        await page.locator('#homeButton').click();
        await page.locator('#activities').getByText('使用活動').click();
        await page.locator('#step1').waitFor();
        await page.getByRole('button',{name:'③ 執行狀態'}).click();
        const original = (await store.list()).activities[0]!;
        await store.save({ ...original.settings, targets: original.settings.targets.map(t => ({ ...t, area: 'C區' })) }, original.id);
        await page.locator('#confirm').check();
        await page.locator('#start').click();
        await page.locator('#message').filter({ hasText: '活動或聯絡資料已變更' }).waitFor();
        assert.equal(await page.evaluate(() => sessionStorage.getItem('ticketpilot-purchase-request')), null);
        await store.save(original.settings, original.id);
        await page.locator('#start').click();await page.getByText('提交結果待確認',{exact:true}).waitFor();
        await page.waitForFunction(()=>document.querySelector('#browser')!.textContent!.includes('購票程序已結束'));
        await page.locator('#homeButton').click();
        await page.locator('#viewRun').click();
        assert.match(await page.locator('#runLabel').innerText(), /上次執行紀錄/);
        await page.reload();await page.locator('#home').waitFor();await page.locator('#viewRun').click();await page.getByText('提交結果待確認',{exact:true}).waitFor();
        await page.waitForTimeout(200);assert.equal(await page.locator('#status').innerText(),'提交結果待確認');
        assert.doesNotMatch(await page.locator('#logs').innerText(),/0999999999|demo@example.com/);
        await page.screenshot({path:'/tmp/ticketpilot-gui-phase6.png',fullPage:true});
        await page.locator('#homeButton').click();
        await page.locator('#activities').getByText('使用活動').click();
        await page.locator('#step1').waitFor();
        await page.getByRole('button',{name:'③ 執行狀態'}).click();
        await page.locator('#simulate').click();
        await page.getByText('模擬完成（未購票）',{exact:true}).waitFor();
        // 模擬畫面收到舊真實快照，標題與日誌仍屬於模擬。
        await page.evaluate('render(currentRun)');
        assert.match(await page.locator('#runLabel').innerText(), /模擬執行紀錄/);
    }finally{await browser.close();await service.close();await rm(dir,{recursive:true,force:true})}
});
