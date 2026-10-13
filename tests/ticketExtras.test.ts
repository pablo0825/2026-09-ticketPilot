import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { KlookTicketExtras, matchesExtraName } from "../src/platforms/klook/ticketExtras.js";
import { runWithRecovery } from "../src/core/recovery.js";
import { PurchaseStop } from "../src/core/purchaseStop.js";
import { SelectionExpiryNotice } from "../src/platforms/klook/notices.js";

let browser: Browser;
before(async () => {
    browser = await chromium.launch();
});
after(async () => {
    await browser?.close();
});
const target = { date: "2027-02-27", time: "18:30", area: "VIP", quantity: 1, adjacent: false, bundle: "演唱會套票 1" };
const options = { bundleEnabled: true, deliveryMethod: "指定地點自取" };
function group(title: string, names: string[], state = "") {
    return `<div class="skuGroup-hk2pfU"><div class="name-Cu4gxk">${title}</div>${names.map(name => `<div class="spec-LwNjSh ${state}">${name}</div>`).join("")}</div>`;
}
function fixture(bundle = group("組合套票", ["演唱會套票1：門票＋eSIM", "演唱會套票10：門票"])) {
    return `<div id="ticket-options">${bundle}${group("取票方式（訂單確認後不可更改）", ["郵寄 (台灣本島)", "指定地點自取"])}<button onclick="document.body.dataset.next='1'">下一步</button></div><script>
    document.querySelectorAll('.spec-LwNjSh').forEach(el => el.onclick = () => {
        document.body.dataset.clicks = String(Number(document.body.dataset.clicks || 0)+1);
        el.parentElement.querySelectorAll('.spec-LwNjSh').forEach(other => other.classList.remove('active-vB3nra'));
        el.classList.add('active-vB3nra');
    });</script>`;
}

test("短名只允許完整名稱或明確分隔，不誤中編號及相似單字", () => {
    assert(matchesExtraName("演唱會套票1：門票", "演唱會套票 1"));
    assert(matchesExtraName("郵寄（台灣本島）", "郵寄"));
    assert(matchesExtraName("套票 [A]：內容", "套票 [A]"));
    for (const text of ["演唱會套票10：門票", "演唱會套票1A", "演唱會套票1 A", "其他演唱會套票1"]) {
        assert(!matchesExtraName(text, "演唱會套票 1"));
    }
    assert(!matchesExtraName("演唱會套票1", ""));
});

test("選取後重排仍按名稱核對，內容更改或選中被清除則停止", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const extras = new KlookTicketExtras(page, target, options, 300, async () => {});
        await extras.select();
        await page.getByText("演唱會套票1：門票＋eSIM", { exact: true }).evaluate(el => el.parentElement!.append(el));
        await extras.verify();
        assert.equal(await page.locator("body").getAttribute("data-clicks"), "2");
        await page
            .getByText("演唱會套票1：門票＋eSIM", { exact: true })
            .evaluate(el => (el.textContent = "演唱會套票1：另一商品"));
        await assert.rejects(extras.verify(), /內容已改變/);
        await page.getByText("演唱會套票1：另一商品", { exact: true }).evaluate(el => {
            el.textContent = "演唱會套票1：門票＋eSIM";
            el.classList.remove("active-vB3nra");
        });
        await assert.rejects(extras.verify(), /選取結果/);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("缺設定、群組重複、同名前綴及停用均停止，不點下一步", async () => {
    const page = await browser.newPage();
    try {
        for (const bundle of [
            group("組合套票", ["演唱會套票1：A", "演唱會套票1：B"]),
            group("組合套票", ["演唱會套票1：A"]) + group("組合套票", ["演唱會套票1：B"]),
            group("組合套票", ["演唱會套票1：A"], "disabled-ImixBj"),
            group("組合套票", ["演唱會套票1：A"], "active-vB3nra disabled-ImixBj"),
            group("組合套票", ["演唱會套票1：A"]).replace(
                "</div></div>",
                "</div><div class='spec-LwNjSh disabled-ImixBj'>演唱會套票1：B</div></div>",
            ),
            group("其他組合套票", ["演唱會套票1：A"]),
        ]) {
            await page.setContent(fixture(bundle));
            await assert.rejects(
                new KlookTicketExtras(page, target, options, 150, async () => {}).select(),
                PurchaseStop,
            );
            assert.equal(await page.locator("body").getAttribute("data-clicks"), null);
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }
        await page.setContent(fixture());
        await assert.rejects(new KlookTicketExtras(page, target, {}, 150, async () => {}).select(), /完成設定/);
    } finally {
        await page.close();
    }
});

test("新群組晚出現會在最終檢查攔截；過期提示保留原錯誤", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent('<div id="ticket-options"></div>');
        const extras = new KlookTicketExtras(page, target, {}, 200, async () => {});
        await extras.select();
        await page
            .locator("#ticket-options")
            .evaluate((el, html) => (el.innerHTML = html), group("取票方式", ["自取"]));
        await assert.rejects(extras.verify(), /完成設定/);
        const expired = new SelectionExpiryNotice("fixture expiry");
        await assert.rejects(
            new KlookTicketExtras(page, target, options, 200, async () => {
                throw expired;
            }).select(),
            error => error === expired,
        );
    } finally {
        await page.close();
    }
});

test("新欄位選取期間過期可恢復重選，第二次同類過期仍受原額度限制", async () => {
    const page = await browser.newPage();
    try {
        // 第一次選完套票後遇到排隊過期，返回時重建頁面
        await page.setContent(fixture());
        let expired = false;
        let recoveries = 0;
        let attempts = 0;
        const attempt = async () => {
            attempts++;
            const extras = new KlookTicketExtras(page, target, options, 200, async () => {
                if (recoveries === 0 && (await page.locator(".active-vB3nra").count()) === 1) {
                    expired = true;
                    throw new SelectionExpiryNotice("排隊過期");
                }
            });
            await extras.select();
            await extras.verify();
        };
        const findRecovery = async () =>
            expired
                ? {
                      kind: "queue" as const,
                      recover: async () => {
                          recoveries++;
                          expired = false;
                          await page.setContent(fixture());
                      },
                  }
                : null;
        await runWithRecovery(attempt, findRecovery);
        assert.equal(attempts, 2);
        assert.equal(recoveries, 1);
        assert.equal(await page.locator(".active-vB3nra").count(), 2);

        // 每次都過期時，不得重設額度或無限重選
        expired = false;
        recoveries = 0;
        await assert.rejects(
            runWithRecovery(async () => {
                const extras = new KlookTicketExtras(page, target, options, 200, async () => {
                    expired = true;
                    throw new SelectionExpiryNotice("再次過期");
                });
                await extras.select();
            }, findRecovery),
            /一次恢復上限/,
        );
        assert.equal(recoveries, 1);
    } finally {
        await page.close();
    }
});

test("點選後未選中會逾時停止，只點一次且不繼續選取票方式", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.getByText("演唱會套票1：門票＋eSIM", { exact: true }).evaluate(el => {
            (el as HTMLElement).onclick = () => {
                document.body.dataset.clicks = String(Number(document.body.dataset.clicks || 0) + 1);
            };
        });
        await assert.rejects(
            new KlookTicketExtras(page, target, options, 200, async () => {}).select(),
            /點選後沒有確認選中/,
        );
        assert.equal(await page.locator("body").getAttribute("data-clicks"), "1");
        assert.equal(await page.locator(".active-vB3nra").count(), 0);
    } finally {
        await page.close();
    }
});
