import { KlookSelectionControls } from "../src/platforms/klook/selectionControls.js";
import { KlookTargetAttempt } from "../src/platforms/klook/targetAttempt.js";
import { PurchaseStop } from "../src/core/purchaseStop.js";
import { PriorityStrategy } from "../src/core/priorityStrategy.js";
import { prepareBooking } from "../src/core/bookingPreparation.js";
import { fixtureConfig as eventConfig } from "./fixtures/purchaseConfig.js";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { KlookTicketSelector } from "../src/platforms/klook/ticketSelector.js";

let browser: Browser;
before(async () => {
    browser = await chromium.launch({ headless: true });
});
after(async () => {
    await browser?.close();
});
const target = { date: "2026-10-03", time: "12:00", area: "A區", quantity: 1, adjacent: false };

// 僅本機測試：結構依讀取到的選票 DOM 縮減，不連線 Klook、不使用登入資料。
function fixture(initialQuantity = 0, brokenSelection = false) {
    const group = (name: string, choices: string[], selected: number) =>
        `<div class="skuGroup-hk2pfU"><div class="name-Cu4gxk">${name}</div><div>${choices
            .map((text, i) => `<div class="spec-LwNjSh ${i === selected ? "active-vB3nra" : ""}">${text}</div>`)
            .join("")}</div></div>`;
    return `<div id="ticket-info"><p>活動日期｜2026 年 10 月 03 日（六）</p></div><div id="ticket-options">
        ${group("日期", ["10月3日(週六)"], 0)}
        ${group("時間", ["12:00", "18:00"], 1)}
        ${group("票種", ["A區（NT$4,880）", "A區愛心席（NT$2,440）", "B區（NT$3,880）"], 2)}
        <div class="eventUnit-kxDycC"><div class="counter-vVrWZ9">
          <div class="btn-vDH5IS"><i class="klk-icon-icon_other_minus_xs">−</i></div>
          <div class="value-xWKzpL">${initialQuantity}</div>
          <div class="btn-vDH5IS"><i class="klk-icon-icon_other_plus_xs">＋</i></div>
        </div><div>最多4張</div></div>
        <div class="consecutive"><span role="checkbox" tabindex="0" aria-checked="true">相連座位<input type="checkbox" checked hidden></span></div>
        <button onclick="document.body.dataset.next='clicked'">下一步</button>
        </div><script>(() => {
        document.querySelectorAll('.spec-LwNjSh').forEach(el => el.onclick = () => {
          if (${brokenSelection}) return;
          [...el.parentElement.children].forEach(item => item.classList.remove('active-vB3nra'));
          el.classList.add('active-vB3nra');
        });
        const value = document.querySelector('.value-xWKzpL');
        document.querySelectorAll('.btn-vDH5IS').forEach((el, index) => el.onclick = () => {
          value.textContent = String(Math.max(0, Math.min(4, Number(value.textContent) + (index ? 1 : -1))));
        });
        const checkbox = document.querySelector('[role=checkbox]');
        checkbox.onclick = () => {
          const input = checkbox.querySelector('input');
          input.checked = !input.checked;
          if (input.checked) checkbox.setAttribute('aria-checked', 'true');
          else checkbox.removeAttribute('aria-checked');
          checkbox.dataset.clicks = String(Number(checkbox.dataset.clicks || 0) + 1);
        };
        })();</script>`;
}

test("選 A 區一張、保留不適用的連票設定並停在下一步之前；重跑不累加", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const adapter = new KlookTicketSelector(page, 800);
        await adapter.selectAndVerify(target);
        // 重跑應保持指定張數，不可再次累加票數。
        await adapter.selectAndVerify(target);
        assert.equal(await page.locator(".value-xWKzpL").innerText(), "1");
        assert.equal(await page.locator("[role=checkbox]").getAttribute("aria-checked"), "true");
        assert.deepEqual(await page.locator(".active-vB3nra").allTextContents(), [
            "10月3日(週六)",
            "12:00",
            "A區（NT$4,880）",
        ]);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("從三張減到一張", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture(3));
        await new KlookTicketSelector(page, 800).selectAndVerify(target);
        assert.equal(await page.locator(".value-xWKzpL").innerText(), "1");
    } finally {
        await page.close();
    }
});

test("單張票沒有連票元件也可通過；多張仍驗證連票設定", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator(".consecutive").evaluate(el => el.remove());
        await new KlookTicketSelector(page, 800).selectAndVerify(target);
        await page.setContent(fixture());
        await new KlookTicketSelector(page, 800).selectAndVerify({ ...target, quantity: 2 });
        assert.equal(await page.locator("[role=checkbox]").getAttribute("aria-checked"), null);
        assert.equal(await page.locator(".consecutive input").isChecked(), false);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("超過 UI 上限停止，不點下一步", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await assert.rejects(
            new KlookTicketSelector(page, 800).selectAndVerify({ ...target, quantity: 5 }),
            /超過 UI 上限/,
        );
        assert.equal(await page.locator(".value-xWKzpL").innerText(), "0");
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("點擊未生效時不宣告成功", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture(0, true));
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target), /點選後沒有確認選中/);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("錯誤設定時停止，不變更選票", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const adapter = new KlookTicketSelector(page, 400);
        for (const invalid of [
            { ...target, date: "2026-02-30" },
            { ...target, time: "25:00" },
            { ...target, quantity: 0 },
            { ...target, area: "　" },
        ]) {
            await assert.rejects(adapter.selectAndVerify(invalid));
        }
        assert.deepEqual(await page.locator(".active-vB3nra").allTextContents(), [
            "10月3日(週六)",
            "18:00",
            "B區（NT$3,880）",
        ]);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("同名票區重複時停止，不任選第一個", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.getByText("A區（NT$4,880）", { exact: true }).evaluate(el => {
            el.parentElement!.append(el.cloneNode(true));
        });
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target), /多個匹配項/);
        assert.equal(await page.locator(".value-xWKzpL").innerText(), "0");
    } finally {
        await page.close();
    }
});

test("加號停用時停止，不誤判目標票數已完成", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator(".klk-icon-icon_other_plus_xs").evaluate(el => {
            el.parentElement!.classList.add("btnDisabled-O7fKf4");
        });
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target), /數量按鈕目前停用/);
        assert.equal(await page.locator(".value-xWKzpL").innerText(), "0");
    } finally {
        await page.close();
    }
});

test("調整數量意外重設票區時，最終驗證必須失敗", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator(".klk-icon-icon_other_plus_xs").evaluate(el => {
            el.parentElement!.addEventListener("click", () => {
                for (const option of document.querySelectorAll(".spec-LwNjSh")) {
                    if (option.textContent === "A區（NT$4,880）") option.classList.remove("active-vB3nra");
                    if (option.textContent === "B區（NT$3,880）") option.classList.add("active-vB3nra");
                }
            });
        });
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify(target), /票區最終驗證不一致/);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("多張票的连票勾選未生效時仍然失敗", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator("[role=checkbox]").evaluate(el => {
            (el as HTMLElement).onclick = () => {};
        });
        await assert.rejects(new KlookTicketSelector(page, 400).selectAndVerify({ ...target, quantity: 2 }));
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("完整名稱唯一匹配，不同價格或無價格皆可設定兩張", async () => {
    const page = await browser.newPage();
    try {
        for (const label of [
            "A區（NT$4,880）",
            "A區 HK$5000.50",
            "A區 $4,880",
            "A區",
            "A區 USD48,80",
            "A區 NT$4880起",
        ]) {
            await page.setContent(fixture().replaceAll("A區（NT$4,880）", label));
            await new KlookTicketSelector(page, 500).selectAndVerify({ ...target, quantity: 2 });
            assert.equal(await page.locator(".value-xWKzpL").innerText(), "2");
            assert.equal(await page.locator(".spec-LwNjSh.active-vB3nra").filter({ hasText: label }).count(), 1);
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }
    } finally {
        await page.close();
    }
});

test("名稱不符、未知限定與重複選項均停止，不點票種或下一步", async () => {
    const page = await browser.newPage();
    try {
        for (const label of [
            "A1區 NT$5000",
            "A區身障票 NT$4880",
            "A區（單人票） NT$48,80",
            "A區（優惠方案二）",
            "A區（NT$4,880）</div><div class='spec-LwNjSh'>A區 HK$3,880",
            "A區（NT$4,880）</div><div class='spec-LwNjSh disabled-ImixBj'>A區 $3,880",
        ]) {
            await page.setContent(fixture().replace("A區（NT$4,880）", label));
            await page
                .locator(".skuGroup-hk2pfU")
                .filter({ hasText: "票種" })
                .evaluate(el => {
                    el.addEventListener("click", () => (document.body.dataset.ticketClicked = "1"));
                });
            await assert.rejects(new KlookTicketSelector(page, 500).selectAndVerify(target), PurchaseStop);
            assert.equal(await page.locator("body").getAttribute("data-ticket-clicked"), null);
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }
    } finally {
        await page.close();
    }
});

test("調整張數後票種名稱改變仍須停止，不沿用先前核對", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator(".klk-icon-icon_other_plus_xs").evaluate(el => {
            el.parentElement!.addEventListener("click", () => {
                const option = [...document.querySelectorAll(".spec-LwNjSh")].find(
                    item => item.textContent === "A區（NT$4,880）",
                )!;
                option.textContent = "A區 VIP NT$5000";
            });
        });
        await assert.rejects(new KlookTicketSelector(page, 500).selectAndVerify(target), PurchaseStop);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("票種不符即使同時有恢復需求，也不換順位、不返回、不消耗恢復", async () => {
    const page = await browser.newPage();
    const attempts: string[] = [];
    let returns = 0;
    let recoveries = 0;
    let active = false;
    const recovery = {
        async isRequired() {
            return active;
        },
        async recover() {
            recoveries++;
        },
    };
    const strategy = new PriorityStrategy({
        ...eventConfig,
        targets: [
            { ...eventConfig.targets[0]!, area: "A區" },
            { ...eventConfig.targets[0]!, area: "B區" },
        ],
    });
    try {
        await page.setContent(fixture().replace("A區（NT$4,880）", "A區 VIP NT$5000"));
        await assert.rejects(
            prepareBooking(
                {
                    selectSeats: () =>
                        strategy.select({
                            async attempt(candidate) {
                                attempts.push(candidate.area);
                                active = true;
                                await new KlookTicketSelector(page, 500).selectAndVerify(candidate);
                                return { status: "matched", value: true };
                            },
                            async returnAfterFailure() {
                                returns++;
                            },
                        }),
                    async confirmSeats() {
                        assert.fail("不得進入選位確認");
                    },
                    async prepareContact() {
                        assert.fail("不得填表");
                    },
                },
                recovery,
                recovery,
            ),
            PurchaseStop,
        );
        assert.deepEqual(attempts, ["A區"]);
        assert.equal(returns, 0);
        assert.equal(recoveries, 0);
    } finally {
        await page.close();
    }
});

test("兩張票可重新勾選連位；已符合設定不重複點擊", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const adapter = new KlookTicketSelector(page, 800);
        const twoTickets = { ...target, quantity: 2 };
        await adapter.selectAndVerify(twoTickets);
        await adapter.selectAndVerify(twoTickets);
        assert.equal(await page.locator("[role=checkbox]").getAttribute("data-clicks"), "1");
        await adapter.selectAndVerify({ ...twoTickets, adjacent: true });
        await adapter.selectAndVerify({ ...twoTickets, adjacent: true });
        assert.equal(await page.locator(".consecutive input").isChecked(), true);
        assert.equal(await page.locator("[role=checkbox]").getAttribute("data-clicks"), "2");
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("連位元件缺少、重複、類型錯誤或狀態矛盾時，不操作連位或提交", async () => {
    const page = await browser.newPage();
    try {
        for (const mode of [
            "missing",
            "duplicate",
            "wrong-type",
            "indeterminate",
            "mixed",
            "contradiction",
            "unknown",
            "outer-duplicate",
            "outer-hidden",
        ]) {
            await page.setContent(fixture());
            await page.locator("[role=checkbox]").evaluate((element, mode) => {
                const input = element.querySelector("input")!;
                if (mode === "missing") input.remove();
                if (mode === "duplicate") element.append(input.cloneNode());
                if (mode === "wrong-type") input.type = "text";
                if (mode === "indeterminate") input.indeterminate = true;
                if (mode === "mixed") element.setAttribute("aria-checked", "mixed");
                if (mode === "contradiction") input.checked = false;
                if (mode === "unknown") element.removeAttribute("aria-checked");
                if (mode === "outer-duplicate") element.parentElement!.append(element.cloneNode(true));
                if (mode === "outer-hidden") (element as HTMLElement).style.display = "none";
            }, mode);
            await assert.rejects(
                new KlookTicketSelector(page, 400).selectAndVerify({ ...target, quantity: 2 }),
                /相連座位/,
            );
            assert.equal(await page.locator("[data-clicks]").count(), 0, mode);
            assert.equal(await page.locator("body").getAttribute("data-next"), null, mode);
        }
    } finally {
        await page.close();
    }
});

test("連位在最後驗證時被重設，必須停止", async t => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        const select = KlookSelectionControls.prototype.select;
        t.mock.method(
            KlookSelectionControls.prototype,
            "select",
            async function (this: KlookSelectionControls, value: Parameters<KlookSelectionControls["select"]>[0]) {
                await select.call(this, value);
                // 操作已完成後頁面重設，不依賴內部讀取次數。
                await page.locator("[role=checkbox]").evaluate(element => {
                    element.querySelector("input")!.checked = false;
                    element.removeAttribute("aria-checked");
                });
            },
        );
        await assert.rejects(
            new KlookTicketSelector(page, 800).selectAndVerify({ ...target, quantity: 2, adjacent: true }),
            /最終相連座位設定不一致/,
        );
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("日期以選項為準：兩場月日與完整年份格式不依賴活動文案", async () => {
    const page = await browser.newPage();
    try {
        for (const [label, date] of [
            ["11月2日(週一)", "2026-11-02"],
            ["11月15日(週日)", "2026-11-15"],
            ["2026/11/02（一）", "2026-11-02"],
            ["2026年11月2日", "2026-11-02"],
            ["１１月０２日（週一）", "2026-11-02"],
        ]) {
            await page.setContent(fixture().replace("10月3日(週六)", label!));
            await page.locator("#ticket-info").evaluate(el => el.remove());
            assert.equal(
                await new KlookTicketSelector(page, 500).selectAndVerify({ ...target, date: date! }),
                "selected",
            );
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }
        // 月日選項不能證明年份；年份交由配位及確認前驗證。
        await page.setContent(fixture());
        assert.equal(
            await new KlookTicketSelector(page, 500).selectAndVerify({ ...target, date: "2027-10-03" }),
            "selected",
        );
    } finally {
        await page.close();
    }
});

test("日期錯年、未知格式、重複或矛盾皆停止，不換順位或消耗恢復", async () => {
    const page = await browser.newPage();
    try {
        for (const mode of ["year", "unknown", "duplicate", "active-disabled", "missing"]) {
            await page.setContent(fixture());
            const dateGroup = page.locator(".skuGroup-hk2pfU").filter({ hasText: "日期" });
            await dateGroup.evaluate((el, mode) => {
                const option = el.querySelector(".spec-LwNjSh")!;
                if (mode === "year") option.textContent = "2027年10月3日";
                if (mode === "unknown") option.textContent = "10/03";
                if (mode === "duplicate") option.after(option.cloneNode(true));
                if (mode === "missing") option.remove();
                if (mode.includes("disabled")) {
                    option.classList.add("disabled-ImixBj");
                }
            }, mode);
            await page
                .locator("#ticket-options")
                .evaluate(el => el.addEventListener("click", () => (document.body.dataset.clicked = "1")));
            let attempts = 0;
            let recoveries = 0;
            const config = {
                ...eventConfig,
                targets: [eventConfig.targets[0]!, { ...eventConfig.targets[0]!, area: "B區" }],
            };
            const strategy = new PriorityStrategy(config);
            const recovery = {
                isRequired: async () => attempts > 0,
                recover: async () => {
                    recoveries++;
                },
            };
            await assert.rejects(
                prepareBooking(
                    {
                        selectSeats: () =>
                            strategy.select({
                                attempt: async () => {
                                    attempts++;
                                    await new KlookTicketSelector(page, 250).selectAndVerify(target);
                                    return { status: "unavailable", reason: "disabled" };
                                },
                                returnAfterFailure: async () => {
                                    throw new Error("不可返回");
                                },
                            }),
                        confirmSeats: async () => {
                            throw new Error("不可確認");
                        },
                        prepareContact: async () => {
                            throw new Error("不可提交");
                        },
                    },
                    recovery,
                    recovery,
                ),
                PurchaseStop,
            );
            assert.equal(attempts, 1);
            assert.equal(recoveries, 0);
            assert.equal(await page.locator("body").getAttribute("data-clicked"), null);
        }
    } finally {
        await page.close();
    }
});

test("日期在後續選票時重排或改字，重新定位並核對日期", async () => {
    const page = await browser.newPage();
    try {
        for (const mode of ["reorder", "replace", "disable", "duplicate"]) {
            await page.setContent(fixture());
            await page.evaluate(mode => {
                const date = document.querySelector(".skuGroup-hk2pfU .spec-LwNjSh")!;
                // 票種被選取後模擬網站更新日期區塊。
                const area = Array.from(document.querySelectorAll(".spec-LwNjSh")).find(
                    el => el.textContent === "A區（NT$4,880）",
                )!;
                area.addEventListener("click", () => {
                    if (mode === "replace") date.textContent = "10月4日(週日)";
                    if (mode === "disable") date.classList.add("disabled-ImixBj");
                    if (mode === "duplicate" || mode === "reorder") {
                        const other = date.cloneNode(true) as HTMLElement;
                        if (mode === "reorder") {
                            other.textContent = "10月4日(週日)";
                            other.classList.remove("active-vB3nra");
                        }
                        date.before(other);
                    }
                });
            }, mode);
            const selection = new KlookTicketSelector(page, 400).selectAndVerify(target);
            if (mode === "reorder") assert.equal(await selection, "selected");
            else await assert.rejects(selection, PurchaseStop);
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }
    } finally {
        await page.close();
    }
});

test("幣種不影響選票，且不自行送出", async () => {
    const page = await browser.newPage();
    try {
        for (const symbol of ["HK$", "NT$", "$"]) {
            await page.setContent(fixture().replaceAll("NT$", symbol));
            const selecting = new KlookTicketSelector(page, 800).selectAndVerify(target);
            assert.equal(await selecting, "selected");
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }
    } finally {
        await page.close();
    }
});

test("正式 adapter 不以金額阻擋配位，仍核對並確認票券", async () => {
    const { KlookTargetAttempt } = await import("../src/platforms/klook/targetAttempt.js");
    const page = await browser.newPage();
    const eventUrl = "https://www.klook.com/zh-TW/event-detail/fixture/";
    const wanted = {
        ...target,
        expectation: { eventName: "Fixture" },
    };
    const panel = `<div class="main_right-ZMnX67" hidden>
        <div class="pc_header_center-mSlDdM"><span>2026年10月3日 週六 下午12:00</span></div>
        <div class="seat_list-BhwLqz"><div class="seat_list_top-Bk0UC9"><div><div>已選1個座位</div></div></div>
        <div class="seat_list_cat-vMvUjF">A區 HK$4,880</div>
        <div class="seat_footer_list-TWhU8V"><div class="list_item-jYRAN7"><span>區 <ins>自由入場</ins></span></div></div>
        <div class="con_seats-a3N26U">共計1個座位</div><div class="con_price-YYYONb">HK$4,880</div>
        <button onclick="document.body.dataset.confirm='1'">確認</button></div></div>`;
    try {
        // 選票與配位之間由正式 adapter 傳遞預期幣別
        await page.route("**/*", route => route.fulfill({ body: "", contentType: "text/html" }));
        await page.goto(eventUrl);
        for (const totalSymbol of ["HK$", "NT$"]) {
            await page.setContent(
                fixture().replaceAll("NT$", "HK$") + panel.replace(">HK$4,880</div>", `>${totalSymbol}4,880</div>`),
            );
            await page.locator("#ticket-options button").evaluate(el => {
                (el as HTMLButtonElement).onclick = () => {
                    (document.querySelector(".main_right-ZMnX67") as HTMLElement).hidden = false;
                };
            });
            const adapter = new KlookTargetAttempt(page, eventUrl, 1000);
            {
                const result = await adapter.attempt(wanted);
                assert.equal(result.status, "matched");
                if (result.status !== "matched") throw new Error("配位未成功");
                await result.value.seatSelector.confirmVerifiedSeats(wanted, result.value.allocation);
                assert.equal(await page.locator("body").getAttribute("data-confirm"), "1");
            }
        }
    } finally {
        await page.close();
    }
});

test("調整張數後改價格可通過，新增同名票種則停止且不送出", async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
        // 模擬設定張數時，網站重畫票種資訊。
        for (const mode of ["price", "duplicate"]) {
            await page.setContent(fixture(1));
            await page.locator(".klk-icon-icon_other_plus_xs").evaluate((el, mode) => {
                el.parentElement!.addEventListener("click", () => {
                    const option = [...document.querySelectorAll(".spec-LwNjSh")].find(
                        item => item.textContent === "A區（NT$4,880）",
                    )!;
                    if (mode === "price") option.textContent = "A區 HK$9,999.50";
                    else {
                        const duplicate = option.cloneNode(true) as HTMLElement;
                        duplicate.classList.remove("active-vB3nra");
                        duplicate.textContent = "A區 USD100";
                        option.after(duplicate);
                    }
                });
            }, mode);

            // 最後一次核對必須重新計算名稱匹配數。
            const selecting = new KlookTicketSelector(page, 500).selectAndVerify({ ...target, quantity: 2 });
            if (mode === "price") assert.equal(await selecting, "selected");
            else await assert.rejects(selecting, /多個匹配/);
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }
        assert.deepEqual(errors, []);
    } finally {
        await page.close();
    }
});

test("純金額與 VIP 混合票種可選，名稱歧義或不同則不點票種", async () => {
    const page = await browser.newPage();
    try {
        // 同一群組含金額票種時，仍可找到金額或 VIP 目標
        const html = fixture(1)
            .replace("A區（NT$4,880）", "NT$6,980")
            .replace("A區愛心席（NT$2,440）", "VIP 1 (已包括VIP粉絲福利)")
            .replace("B區（NT$3,880）", "NT$8,380 - 看台");
        for (const area of ["NT$6,980", "VIP 1 (已包括VIP粉絲福利)", "NT$8,380 - 看台"]) {
            await page.setContent(html);
            assert.equal(await new KlookTicketSelector(page, 500).selectAndVerify({ ...target, area }), "selected");
            assert.equal(
                await page.getByText(area, { exact: true }).getAttribute("class"),
                "spec-LwNjSh active-vB3nra",
            );
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }

        // 不同金額、幣別、限定與重複名稱都不能選取
        for (const label of [
            "NT$4,980",
            "HK$6,980",
            "NT$6,980 - 內場",
            "NT$6,980</div><div class='spec-LwNjSh'>NT$6,980",
            "NT$6,980</div><div class='spec-LwNjSh disabled-ImixBj'>NT$6,980",
        ]) {
            await page.setContent(html.replace("NT$6,980", label));
            await page
                .locator(".skuGroup-hk2pfU")
                .filter({ hasText: "票種" })
                .evaluate(el => {
                    el.addEventListener("click", () => (document.body.dataset.ticketClicked = "1"));
                });
            await assert.rejects(
                new KlookTicketSelector(page, 500).selectAndVerify({ ...target, area: "NT$6,980" }),
                PurchaseStop,
            );
            assert.equal(await page.locator("body").getAttribute("data-ticket-clicked"), null);
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }
    } finally {
        await page.close();
    }
});

test("套票與取票方式接入選票，張數操作清除選中時不放行", async () => {
    const page = await browser.newPage();
    try {
        // 補入兩組實站觀察結構，沿用 fixture 選取事件
        const extra = (title: string, name: string) =>
            `<div class="skuGroup-hk2pfU"><div class="name-Cu4gxk">${title}</div><div><div class="spec-LwNjSh">${name}</div></div></div>`;
        const html = fixture().replace(
            '<div class="eventUnit-kxDycC">',
            extra("組合套票", "演唱會套票1：門票") +
                extra("取票方式 (訂單確認後不可更改)", "指定地點自取") +
                '<div class="eventUnit-kxDycC">',
        );
        const wanted = { ...target, bundle: "演唱會套票 1" };
        const extras = { bundleEnabled: true, deliveryMethod: "指定地點自取" };
        await page.setContent(html);
        assert.equal(await new KlookTicketSelector(page, 500).selectAndVerify(wanted, extras), "selected");
        assert.equal(await page.locator("body").getAttribute("data-next"), null);

        // 活動沒有取票群組時，保留設定也能完成選票
        await page.setContent(html);
        await page
            .locator(".skuGroup-hk2pfU")
            .filter({ hasText: "取票方式" })
            .evaluate(el => el.remove());
        assert.equal(await new KlookTicketSelector(page, 500).selectAndVerify(wanted, extras), "selected");
        assert.equal(await page.locator(".value-xWKzpL").innerText(), "1");

        // 後續數量操作重設套票，最後核對必須停止
        await page.setContent(html);
        await page
            .locator(".btn-vDH5IS")
            .last()
            .evaluate(el => {
                el.addEventListener("click", () => {
                    for (const option of document.querySelectorAll(".spec-LwNjSh")) {
                        if (option.textContent?.startsWith("演唱會套票")) option.classList.remove("active-vB3nra");
                    }
                });
            });
        await assert.rejects(new KlookTicketSelector(page, 500).selectAndVerify(wanted, extras), /組合套票選取結果/);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("新套票停用不切下一順位，取票方式設定傳到實際 adapter", async () => {
    const page = await browser.newPage();
    try {
        // 選票頁不會送出，保留真實網址以通過既有提示檢查
        await page.route(eventConfig.eventUrl, route =>
            route.fulfill({ body: fixture(1), contentType: "text/html; charset=utf-8" }),
        );
        await page.goto(eventConfig.eventUrl);
        await page.locator("#ticket-options").evaluate(el => {
            el.insertAdjacentHTML(
                "beforeend",
                '<div class="skuGroup-hk2pfU"><div class="name-Cu4gxk">組合套票</div><div class="spec-LwNjSh disabled-ImixBj">套票1：門票</div></div>',
            );
        });
        const config = {
            ...eventConfig,
            bundleEnabled: true,
            targets: [eventConfig.targets[0]!, { ...eventConfig.targets[0]!, area: "B區" }].map(t => ({
                ...t,
                bundle: "套票1",
            })),
        };
        const strategy = new PriorityStrategy(config);
        const adapter = new KlookTargetAttempt(page, eventConfig.eventUrl, 300, config);
        let attempts = 0;
        await assert.rejects(
            strategy.select({
                attempt: async wanted => {
                    attempts++;
                    return adapter.attempt(wanted);
                },
                returnAfterFailure: async () => {
                    throw new Error("不應返回");
                },
            }),
            /組合套票目前無法選取/,
        );
        assert.equal(attempts, 1);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);

        // 獨立取票方式設定必須傳至選票器，不能被靜默忽略
        await page.setContent(fixture(1));
        await page.locator("#ticket-options").evaluate(el => {
            el.insertAdjacentHTML(
                "beforeend",
                '<div class="skuGroup-hk2pfU"><div class="name-Cu4gxk">取票方式</div><div class="spec-LwNjSh">郵寄</div></div>',
            );
        });
        await assert.rejects(
            new KlookTargetAttempt(page, eventConfig.eventUrl, 200, { deliveryMethod: "自取" }).attempt(
                eventConfig.targets[0]!,
            ),
            /找不到唯一符合的取票方式/,
        );
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("香港套餐類型不依賴外觀 class；載入時舊選項不得視為完成", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.evaluate(() => {
            document.querySelectorAll(".skuGroup-hk2pfU, .name-Cu4gxk, .spec-LwNjSh").forEach(el => {
                el.classList.remove("skuGroup-hk2pfU", "name-Cu4gxk", "spec-LwNjSh");
            });
            const heading = [...document.querySelectorAll("div")].find(el => el.textContent === "票種")!;
            heading.textContent = "套餐類型";
            const option = heading.nextElementSibling!.firstElementChild as HTMLElement;
            option.onclick = () => {
                document.body.dataset.areaClicks = String(Number(document.body.dataset.areaClicks ?? 0) + 1);
                const loading = document.createElement("div");
                loading.className = "klk-loading";
                loading.textContent = "載入中";
                document.querySelector("#ticket-options")!.append(loading);
                setTimeout(() => {
                    [...option.parentElement!.children].forEach(el => el.classList.remove("active-vB3nra"));
                    option.classList.add("active-vB3nra");
                    loading.remove();
                }, 300);
            };
            document.querySelector(".klk-icon-icon_other_plus_xs")!.parentElement!.addEventListener("click", () => {
                if (document.querySelector(".klk-loading")) document.body.dataset.clickedWhileLoading = "true";
            });
        });
        await new KlookTicketSelector(page, 1500).selectAndVerify(target);
        assert.equal(await page.locator("body").getAttribute("data-area-clicks"), "1");
        assert.equal(await page.locator("body").getAttribute("data-clicked-while-loading"), null);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("時間目標延遲加入時等待；日期時間定位錯誤仍停止且不恢復", async t => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.getByText("12:00", { exact: true }).evaluate(el => {
            el.remove();
            setTimeout(() => {
                const group = [...document.querySelectorAll("div")].find(
                    el => el.textContent === "時間",
                )!.nextElementSibling!;
                group.querySelectorAll(".active-vB3nra").forEach(el => el.classList.remove("active-vB3nra"));
                group.insertAdjacentHTML("beforeend", '<div class="spec-LwNjSh active-vB3nra">12:00</div>');
            }, 300);
        });
        await new KlookTicketSelector(page, 1500).selectAndVerify(target);
        await page.setContent(fixture());
        t.mock.method(page, "evaluateHandle", async () => {
            await page.evaluate(() =>
                document.body.insertAdjacentHTML(
                    "beforeend",
                    '<div class="klk-modal-alert">抱歉，時間到了！ 請返回並重新排隊<button>OK</button></div>',
                ),
            );
            throw new Error("模擬點擊前 DOM 脫離");
        });
        await assert.rejects(new KlookTicketSelector(page, 800).selectAndVerify(target), PurchaseStop);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("張數從限購文字找計數器，忽略旁邊數字並等待延遲數值", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.evaluate(() => {
            const row = document.querySelector(".eventUnit-kxDycC")!;
            row.lastElementChild!.innerHTML = "<span>2</span><span>最多4張</span>";
            const value = document.querySelector(".value-xWKzpL")!;
            const next = value.nextSibling;
            const parent = value.parentElement!;
            value.remove();
            setTimeout(() => parent.insertBefore(value, next), 300);
            document
                .querySelectorAll(".eventUnit-kxDycC, .counter-vVrWZ9, .value-xWKzpL, .btn-vDH5IS, .consecutive")
                .forEach(el => el.removeAttribute("class"));
        });
        await new KlookTicketSelector(page, 1500).selectAndVerify({ ...target, quantity: 2 });
        const counter = page.locator(".klk-icon-icon_other_plus_xs").locator("..").locator("..");
        assert.match(await counter.innerText(), /2/);
        assert.equal(await page.locator("[role=checkbox] input").isChecked(), false);
        assert.equal(await page.locator("body").getAttribute("data-next"), null);
    } finally {
        await page.close();
    }
});

test("張數更新延遲只點一次；停用仍保留一般錯誤分類", async () => {
    const page = await browser.newPage();
    try {
        await page.setContent(fixture());
        await page.locator(".klk-icon-icon_other_plus_xs").evaluate(icon => {
            icon.parentElement!.onclick = () => {
                document.body.dataset.plusClicks = String(Number(document.body.dataset.plusClicks ?? 0) + 1);
                setTimeout(() => {
                    document.querySelector(".value-xWKzpL")!.textContent = "1";
                }, 300);
            };
        });
        await new KlookTicketSelector(page, 1500).selectAndVerify(target);
        assert.equal(await page.locator("body").getAttribute("data-plus-clicks"), "1");
        await page.setContent(fixture());
        await page.locator(".klk-icon-icon_other_plus_xs").evaluate(icon => {
            icon.parentElement!.classList.add("btnDisabled-O7fKf4");
            document.body.insertAdjacentHTML(
                "beforeend",
                '<div class="klk-modal-alert">抱歉，時間到了！ 請返回並重新排隊<button>OK</button></div>',
            );
        });
        await assert.rejects(
            new KlookTicketSelector(page, 800).selectAndVerify(target),
            error => error instanceof Error && !(error instanceof PurchaseStop),
        );
    } finally {
        await page.close();
    }
});

test("最後核對等待載入結束；載入後重設時間或新增未設定套票都不放行", async t => {
    const page = await browser.newPage();
    const select = KlookSelectionControls.prototype.select;
    let mode = "same";
    t.mock.method(
        KlookSelectionControls.prototype,
        "select",
        async function (this: KlookSelectionControls, value: Parameters<KlookSelectionControls["select"]>[0]) {
            await select.call(this, value);
            await page.evaluate(mode => {
                const root = document.querySelector("#ticket-options")!;
                const loading = document.createElement("div");
                loading.className = "klk-loading";
                loading.textContent = "載入中";
                root.append(loading);
                setTimeout(() => {
                    if (mode === "time") {
                        const group = [...root.querySelectorAll("div")].find(
                            el => el.textContent === "時間",
                        )!.nextElementSibling!;
                        [...group.children].forEach(el =>
                            el.classList.toggle("active-vB3nra", el.textContent === "18:00"),
                        );
                    }
                    if (mode === "extra")
                        root.insertAdjacentHTML(
                            "beforeend",
                            '<div><div>組合套票</div><div><div class="active-vB3nra">套票1</div></div></div>',
                        );
                    loading.remove();
                    document.body.dataset.finishedLoading = "true";
                }, 300);
            }, mode);
        },
    );
    try {
        for (mode of ["same", "time", "extra"]) {
            await page.setContent(fixture());
            const run = new KlookTicketSelector(page, 1500).selectAndVerify(target);
            if (mode === "same") assert.equal(await run, "selected");
            else await assert.rejects(run, mode === "time" ? /時間最終驗證不一致/ : /請先完成設定/);
            assert.equal(await page.locator("body").getAttribute("data-finished-loading"), "true");
            assert.equal(await page.locator("body").getAttribute("data-next"), null);
        }
    } finally {
        await page.close();
    }
});
