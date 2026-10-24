import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { KlookTicketExtras, matchesExtraName } from "../src/platforms/klook/ticketExtras.js";
import { runWithRecovery } from "../src/core/recovery.js";
import { PurchaseStop } from "../src/core/purchaseStop.js";
import { readSelectionDom } from "../src/platforms/klook/selectionDom.js";
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

test("取票群組不存在可略過，仍選取套票並通過最終檢查", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page
            .locator(".skuGroup-hk2pfU")
            .nth(1)
            .evaluate(el => el.remove());
        const extras = new KlookTicketExtras(page, target, options, 200, async () => {});
        await extras.select();
        await extras.verify();
        assert.equal(await page.locator("body").getAttribute("data-clicks"), "1");
        assert.equal(await page.locator(".active-vB3nra").innerText(), "演唱會套票1：門票＋eSIM");
    } finally {
        await page.close();
    }
});

test("取票群組存在時仍拒絕缺設定、錯誤選項、重複或停用", async () => {
    const page = await browser.newPage();
    try {
        for (const [delivery, reason] of [
            [group("取票方式", ["郵寄"]), /找不到唯一符合的取票方式/],
            [group("取票方式", ["指定地點自取"], "disabled-ImixBj"), /目前無法選取/],
            [group("取票方式", ["指定地點自取"]) + group("取票方式", ["指定地點自取"]), /群組不唯一/],
            [group("取票方式", ["指定地點自取：A", "指定地點自取：B"]), /多個匹配選項/],
        ] as const) {
            await page.setContent('<div id="ticket-options">' + delivery + "</div>");
            await page.locator(".spec-LwNjSh").evaluateAll(elements => {
                for (const el of elements) {
                    el.addEventListener("click", () => {
                        document.body.dataset.clicks = "1";
                        el.classList.add("active-vB3nra");
                    });
                }
            });
            const extras = new KlookTicketExtras(page, target, { deliveryMethod: "指定地點自取" }, 200, async () => {});
            await assert.rejects(extras.select(), reason);
            assert.equal(await page.locator("body").getAttribute("data-clicks"), null);
        }
        await page.setContent('<div id="ticket-options">' + group("取票方式", ["指定地點自取"]) + "</div>");
        await assert.rejects(new KlookTicketExtras(page, target, {}, 200, async () => {}).select(), /完成設定/);
    } finally {
        await page.close();
    }
});

test("取票方式選取後消失不可略過，略過後才出現也不默認已選", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const selected = new KlookTicketExtras(page, target, options, 200, async () => {});
        await selected.select();
        await page
            .locator(".skuGroup-hk2pfU")
            .nth(1)
            .evaluate(el => el.remove());
        await assert.rejects(selected.verify(), /找不到唯一符合的取票方式/);

        await page.setContent('<div id="ticket-options"></div>');
        const skipped = new KlookTicketExtras(page, target, { deliveryMethod: "指定地點自取" }, 200, async () => {});
        await skipped.select();
        await page
            .locator("#ticket-options")
            .evaluate((el, html) => (el.innerHTML = html), group("取票方式", ["指定地點自取"]));
        await assert.rejects(skipped.verify(), /內容已改變/);
        assert.equal(await page.locator(".active-vB3nra").count(), 0);
    } finally {
        await page.close();
    }
});

test("套票用內容群組定位，等待載入與選中更新，重跑不重複點擊", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(
            `<section><h2>票券選擇</h2><div class="klk-loading">載入中</div></section><button onclick="document.body.dataset.next='1'">下一步</button>`,
        );
        await page.evaluate(() => {
            setTimeout(() => {
                const root = document.querySelector("section")!;
                root.innerHTML =
                    '<h2>票券選擇</h2><div><div>組合套票</div><div><div id="bundle">演唱會套票1：門票＋eSIM</div><div>演唱會套票10：門票</div></div></div>';
                document.querySelector<HTMLElement>("#bundle")!.onclick = () => {
                    document.body.dataset.clicks = String(Number(document.body.dataset.clicks ?? 0) + 1);
                    root.insertAdjacentHTML("beforeend", '<div class="klk-loading">載入中</div>');
                    setTimeout(() => {
                        document.querySelector("#bundle")!.classList.add("active-vB3nra");
                        document.querySelector(".klk-loading")!.remove();
                    }, 250);
                };
            }, 250);
        });
        const extras = new KlookTicketExtras(page, target, { bundleEnabled: true }, 1500, async () => {});
        await extras.select();
        await extras.verify();
        await extras.select();
        assert.equal(await page.locator("body").getAttribute("data-clicks"), "1");
        assert.equal(await page.locator(".klk-loading").count(), 0);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("套票點擊前群組變動即停止，點擊無效時不補點", async () => {
    const page = await browser.newPage();
    try {
        for (const mode of ["changed", "no-update"]) {
            await page.setContent(fixture());
            if (mode === "no-update")
                await page.getByText("演唱會套票1：門票＋eSIM", { exact: true }).evaluate(el => {
                    (el as HTMLElement).onclick = () => {
                        document.body.dataset.clicks = String(Number(document.body.dataset.clicks ?? 0) + 1);
                    };
                });
            let reads = 0;
            const extras = new KlookTicketExtras(page, target, options, 500, async () => {
                // 初次 DOM 前、後，再到操作前的 observer；在動作邊界注入重複候選。
                if (mode === "changed" && ++reads === 3)
                    await page.getByText("演唱會套票1：門票＋eSIM", { exact: true }).evaluate(el => {
                        const copy = el.cloneNode(true);
                        copy.textContent = "演唱會套票1：另一方案";
                        el.after(copy);
                    });
            });
            await assert.rejects(extras.select(), PurchaseStop);
            assert.equal(await page.locator("body").getAttribute("data-clicks"), mode === "changed" ? null : "1");
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }
    } finally {
        await page.close();
    }
});

test("套票操作後才停用，完整 DOM 最終核對仍停止", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const extras = new KlookTicketExtras(page, target, options, 500, async () => {});
        await extras.select();
        await page
            .getByText("演唱會套票1：門票＋eSIM", { exact: true })
            .evaluate(el => el.setAttribute("aria-disabled", "true"));
        const snapshot = await readSelectionDom(page);
        assert.throws(() => extras.verifySnapshot(snapshot), /組合套票目前無法選取/);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});
