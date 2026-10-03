import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chromium } from "playwright";
import { acquirePurchaseLease, purchaseOccupied, releasePurchaseLease } from "../src/app/purchaseLock.js";
import { PurchaseRuns } from "../src/local/purchaseRuns.js";
import { runPurchase } from "../src/app/runPurchase.js";
import { fixtureConfig } from "./fixtures/purchaseConfig.js";
const worker = new URL("./fixtures/guiPurchaseWorker.ts", import.meta.url);
const contact = { firstName: "Demo", lastName: "Test", regionLabel: "台灣 (+886)", phone: "0912345678", email: "fixture@example.com" };
const activity = { eventUrl:"https://www.klook.com/zh-TW/event-detail/fixture/",eventName:"Fixture",fallbackMode:"STRICT",excludeKeywords:[],targets:[{date:"2026-11-02",time:"19:30",area:"B區",unitPrice:5280,quantity:1,adjacent:false}] };
async function until(check:()=>boolean){for(let i=0;i<100&&!check();i++)await new Promise(r=>setTimeout(r,30));assert(check())}

test("實際 runner 的占用必須等流程與瀏覽器都結束，兩種先後順序皆正確", async()=>{
    for(const closeFirst of [false,true]){
        const dir=await mkdtemp(join(tmpdir(),'ticket-lease-'));const lease=acquirePurchaseLease(dir);
        const context=new EventEmitter();let releaseNavigation:()=>void=()=>{};
        const pending=new Promise<void>(resolve=>releaseNavigation=resolve);
        const page={evaluate:async()=>false,goto:async()=>{await pending;return {ok:()=>false,status:()=>403}}};
        Object.assign(context,{pages:()=>[page]});
        const launch=mock.method(chromium,'launchPersistentContext',async()=>context as never);
        try{
            let opened=false;
            const result=runPurchase(fixtureConfig,contact,{lease,onBrowser:()=>{opened=true}});
            const rejected=assert.rejects(result,/HTTP 403/);
            await until(()=>opened);
            assert.throws(()=>acquirePurchaseLease(dir),/占用/);
            if(closeFirst){context.emit('close');assert(purchaseOccupied(dir))}
            releaseNavigation();await rejected;
            if(!closeFirst){assert(purchaseOccupied(dir));context.emit('close')}
            assert(!purchaseOccupied(dir));
        }finally{launch.mock.restore();await rm(dir,{recursive:true,force:true})}
    }
});

test("付款結果不等於可重啟；相同請求與服務重開不重複執行",async()=>{
    const dir=await mkdtemp(join(tmpdir(),'ticket-runs-'));const runs=new PurchaseRuns(dir,worker);const id=randomUUID();
    try{
        const first=runs.start(id,activity,contact);
        assert.equal(runs.start(id,activity,contact).id,first.id);
        await until(()=>runs.snapshot()?.status==='payment-ready');
        assert(runs.busy());assert.throws(()=>runs.start(randomUUID(),activity,contact),/占用/);
        assert.throws(()=>runs.close(),/尚未結束/);
        await until(()=>!runs.busy());
        assert.equal(runs.snapshot()?.status,'payment-ready');
        runs.close();
        const restarted=new PurchaseRuns(dir,worker);
        assert.equal(restarted.start(id,activity,contact).id,first.id);
        assert(!restarted.busy());restarted.close();
    }finally{await until(()=>!runs.busy());runs.close();await rm(dir,{recursive:true,force:true})}
});

test("程序異常保留占用、重啟不續購；錯設定不拿占用",async()=>{
    const dir=await mkdtemp(join(tmpdir(),'ticket-crash-'));const runs=new PurchaseRuns(dir,worker);
    try{
        assert.throws(()=>runs.start(randomUUID(),{},contact));assert(!purchaseOccupied(dir));
        const id=randomUUID();const data={...activity,eventName:'CRASH'};runs.start(id,data,contact);
        await until(()=>runs.snapshot()?.status==='interrupted');
        assert(purchaseOccupied(dir));runs.close();
        const next=new PurchaseRuns(dir,worker);
        assert.equal(next.start(id,data,contact).status,'interrupted');
        assert.throws(()=>next.start(randomUUID(),activity,contact),/占用/);next.close();
    }finally{runs.close();await rm(dir,{recursive:true,force:true})}
});
