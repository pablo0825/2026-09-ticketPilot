import { PurchaseStop } from "../src/core/purchaseStop.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { KlookSeatSelector, getSeatResultMismatch, type SeatResult } from "../src/platforms/klook/seatSelector.js";

const target = { date: "2026-10-03", time: "12:00", area: "A區", quantity: 1, adjacent: false };
const result: SeatResult = {
    session: "2026年10月3日 週六 下午12:00",
    text: "2026年10月3日 週六 下午12:00 已選1個座位",
    area: " A區（NT$4,880） ",
    total: " 共計1個座位 ",
    selected: "已選1個座位",
    price: "NT$4,880",
    group: null,
    structureValid: true,
    loading: false,
    seats: [{ section: "A2", row: "4", number: "17" }],
};

test("核對場次、票種、完整且不重複的座位；A2 不等同票種名稱", () => {
    assert.equal(getSeatResultMismatch(result, target), undefined);
    for (const change of [
        { session: result.session.replace("2026年", "2027年") },
        { session: result.session.replace("下午", "上午") },
        { session: result.session.replace("12:00", "18:00") },
        { area: "A區愛心席（NT$4,880）" },
        { area: "B區（NT$3,880）" },
        { total: "共計2個座位" },
        { seats: [] },
        { seats: [{ section: "A2", row: "4", number: "" }] },
    ])
        assert.notEqual(getSeatResultMismatch({ ...result, ...change }, target), undefined);
    assert.notEqual(
        getSeatResultMismatch(
            {
                ...result,
                text: result.text.replace("已選1", "已選2"),
                selected: "已選2個座位",
                total: "共計2個座位",
                seats: [...result.seats, ...result.seats],
            },
            { ...target, quantity: 2 },
        ),
        undefined,
    );
});

test("等待彈窗內延遲配位；只按一次下一步且不按確認；不完整或停用時停止", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        for (const { ready, price } of [
            { ready: true, price: 4880 },
            { ready: false, price: 4880 },
            { ready: true, price: 5000 },
        ]) {
            await page.setContent(`<div id="ticket-options"><button onclick="openPanel()">下一步</button></div>
                <script>
                var clicks = 0;
                function openPanel() {
                    document.body.dataset.clicks = String(++clicks);
                    const panel = document.createElement('div');
                    panel.className = 'main_right-ZMnX67';
                    panel.textContent = '載入中'; document.body.append(panel);
                    setTimeout(() => { panel.innerHTML = '<div class="pc_header_center-mSlDdM"><span>2026年10月3日 週六 下午12:00</span></div><div class="seat_list-BhwLqz"><div class="seat_list_top-Bk0UC9"><div><div>已選1個座位</div></div></div><div class="seat_list_cat-vMvUjF">A區（NT$${price}）</div><div class="seat_footer_list-TWhU8V"><div class="list_item-jYRAN7"><span>區 <ins>A2</ins></span><span>排 <ins>4</ins></span><span>座位 <ins>17</ins></span></div></div><div class="con_price-YYYONb">NT$4,880</div><div class="con_seats-a3N26U">共計1個座位</div><button ${ready ? "" : "disabled"} onclick="document.body.dataset.confirmed=1">確認</button></div>'; }, 300);
                }
                </script>`);
            const selector = new KlookSeatSelector(page, 4880, ready ? 2000 : 800);
            if (price !== 4880) await assert.rejects(selector.openAndVerify(target), PurchaseStop);
            else if (ready)
                assert.deepEqual(await selector.openAndVerify(target), { kind: "reserved", seats: result.seats });
            else await assert.rejects(selector.openAndVerify(target), /逾時/);
            assert.equal(await page.locator("body").getAttribute("data-clicks"), "1");
            assert.equal(await page.locator("body").getAttribute("data-confirmed"), null);
        }
    } finally {
        await browser.close();
    }
});

test("不符原因可供診斷，上午十二點與下午十二點正確區分", () => {
    assert.match(
        getSeatResultMismatch({ ...result, session: result.session.replace("12:00", "06:00") }, target)!,
        /預期 12:00，實際 18:00/,
    );
    assert.match(getSeatResultMismatch({ ...result, area: "B區（NT$3,880）" }, target)!, /票種不符/);
    assert.match(
        getSeatResultMismatch({ ...result, seats: [{ section: "A2", row: "", number: "17" }] }, target)!,
        /資料不完整/,
    );
    assert.equal(
        getSeatResultMismatch(
            { ...result, session: result.session.replace("下午", "上午") },
            { ...target, time: "00:00" },
        ),
        undefined,
    );
});

test("錯誤提示立即停止；不符保留原因；已有或重複彈窗不按下一步", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const panel = (text: string) => `<div class="main_right-ZMnX67">${text}</div>`;
    try {
        for (const existing of [panel("已有選位"), panel("第一個") + panel("第二個")]) {
            await page.setContent(
                `<div id="ticket-options"><button onclick="document.body.dataset.clicked=1">下一步</button></div>${existing}`,
            );
            await assert.rejects(new KlookSeatSelector(page, 4880, 500).openAndVerify(target), /已有選位|不唯一/);
            assert.equal(await page.locator("body").getAttribute("data-clicked"), null);
        }
        for (const text of ["選位失敗，請重試", "2026年10月3日 週六 下午06:00"]) {
            await page.setContent(
                `<div id="ticket-options"><button onclick="document.querySelector('.main_right-ZMnX67').hidden=false; document.body.dataset.clicked=1">下一步</button></div><div class="main_right-ZMnX67" hidden><div class="pc_header_center-mSlDdM"><span>${text}</span></div></div>`,
            );
            const expected = text.includes("失敗")
                ? /選位畫面顯示失敗或逾時/
                : /等待配位結果逾時：時間不符：預期 12:00，實際 18:00/;
            await assert.rejects(new KlookSeatSelector(page, 4880, 500).openAndVerify(target), expected);
            assert.equal(await page.locator("body").getAttribute("data-clicked"), "1");
        }
    } finally {
        await browser.close();
    }
});

test("場次後接倒數時保留文字邊界，不把 12:00 與 00:06 黏在一起", () => {
    const text = "2026年10月3日 週六 下午12:00\n00:06\n已選1個座位";
    assert.equal(getSeatResultMismatch({ ...result, text }, target), undefined);
    assert.notEqual(
        getSeatResultMismatch({ ...result, session: result.session.replace("下午12:00", "下午06:00") }, target),
        undefined,
    );
});

const generalTarget = { date: "2026-11-15", time: "17:00", area: "獨立靠近(單人票)", quantity: 2, adjacent: false };
const generalAllocation = { kind: "general" as const, group: "一般 票", quantity: 2 };
function allocationFixture(
    options: { rows?: string; selected?: string; total?: string; price?: string; loading?: string; area?: string } = {},
): string {
    const row = options.rows ?? '<div class="list_item-jYRAN7"><div><span> 區 <ins>一般 票</ins></span></div></div>';
    return `<div id="ticket-options"><button onclick="document.querySelector('.seatModal_main-Dpti0D').hidden=false; document.body.dataset.next=String(Number(document.body.dataset.next||0)+1)">下一步</button></div>
    <div class="seatModal_main-Dpti0D" hidden>${options.loading ?? ""}<div class="main_right-ZMnX67">
    <div class="pc_header_center-mSlDdM"><span>2026年11月15日 週日 下午5:00</span></div><div class="seat_list-BhwLqz">
    <div class="seat_list_top-Bk0UC9"><div><div>${options.selected ?? "已選2個座位"}</div></div></div>
    <div class="seat_list_cat-vMvUjF">${options.area ?? "獨立靠近(單人票) NT$1280"}</div>
    <div class="seat_footer_list-TWhU8V">${row}</div>
    <div class="con_seats-a3N26U">${options.total ?? "共計2個座位"}</div>
    <div class="con_price-YYYONb">${options.price ?? "NT$2,560"}</div>
    <button onclick="document.body.dataset.confirm=String(Number(document.body.dataset.confirm||0)+1)">確認</button>
    </div></div></div>`;
}

test("一般票兩張一列：等待 loader 退出及票種完整，只確認一次", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.setContent(
            allocationFixture({
                area: "",
                loading: '<div class="seatsio-loading-screen" style="height:20px">loading</div>',
            }),
        );
        const selector = new KlookSeatSelector(page, 1280, 2500);
        const pending = selector.openAndVerify(generalTarget);
        await page.locator(".main_right-ZMnX67").waitFor({ state: "visible" });
        await page.waitForTimeout(250);
        assert.equal(await page.locator("body").getAttribute("data-confirm"), null);
        await page.evaluate(() => {
            document.querySelector(".seat_list_cat-vMvUjF")!.textContent = "獨立靠近(單人票) NT$1280";
            const loader = document.querySelector(".seatsio-loading-screen") as HTMLElement;
            loader.classList.add("hide");
            loader.style.opacity = "0";
        });
        const allocation = await pending;
        assert.deepEqual(allocation, generalAllocation);
        assert.equal(await page.locator("body").getAttribute("data-next"), "1");
        await selector.confirmVerifiedSeats(generalTarget, allocation);
        assert.equal(await page.locator("body").getAttribute("data-confirm"), "1");
    } finally {
        await browser.close();
    }
});

test("完整兩張劃位仍逐座驗證；不以座號數字差判斷連位", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        const seats = [24, 22]
            .map(
                number =>
                    `<div class="list_item-jYRAN7"><span>區 <ins>A2</ins></span><span>排 <ins>7</ins></span><span>座位 <ins>${number}</ins></span></div>`,
            )
            .join("");
        // 真實 Jason DOM 在張數旁包含自行選位按鈕，不能併入張數文字。
        await page.setContent(allocationFixture({ rows: seats }));
        await page
            .locator(".seat_list_top-Bk0UC9")
            .evaluate(el => el.insertAdjacentHTML("beforeend", "<button>自行選位</button>"));
        const selector = new KlookSeatSelector(page, 1280, 800);
        const allocation = await selector.openAndVerify(generalTarget);
        assert.deepEqual(allocation, {
            kind: "reserved",
            seats: [
                { section: "A2", row: "7", number: "24" },
                { section: "A2", row: "7", number: "22" },
            ],
        });
        await selector.confirmVerifiedSeats(generalTarget, allocation);
        assert.equal(await page.locator("body").getAttribute("data-confirm"), "1");
    } finally {
        await browser.close();
    }
});

test("一般票不接受缺漏、混合、重複、錯價、錯張數與連位要求", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        const generalRow = '<div class="list_item-jYRAN7"><span>區 <ins>一般票</ins></span></div>';
        const unknownRow =
            '<div class="list_item-jYRAN7"><span>區 <ins>A2</ins></span><span>排 <ins>3</ins></span><span>座位 <ins></ins></span></div>';
        for (const options of [
            { rows: unknownRow },
            { rows: generalRow.replace("一般票", "　 ") },
            { rows: generalRow.replace("<ins>一般票</ins>", "") },
            { rows: generalRow.replace("</span>", "</span><span>排 <ins>3</ins></span>") },
            { rows: generalRow + unknownRow },
            { rows: generalRow + generalRow },
            { rows: generalRow.replace("</span>", "</span><ins>額外資料</ins>") },
            { selected: "已選12個座位" },
            { total: "共計1個座位" },
            { price: "NT$1,280" },
            { area: "獨立靠近(單人票) NT$1680" },
            { loading: '<div class="seatsio-loading-screen hide" style="height:20px;opacity:1">loading</div>' },
        ]) {
            await page.setContent(allocationFixture(options));
            await assert.rejects(new KlookSeatSelector(page, 1280, 450).openAndVerify(generalTarget), PurchaseStop);
            assert.equal(await page.locator("body").getAttribute("data-confirm"), null);
        }
        for (const selector of [
            ".seat_list-BhwLqz",
            ".seat_list_top-Bk0UC9",
            ".seat_list_cat-vMvUjF",
            ".con_price-YYYONb",
            ".con_seats-a3N26U",
            ".seat_footer_list-TWhU8V",
        ]) {
            await page.setContent(allocationFixture());
            await page.locator(selector).evaluate(el => el.after(el.cloneNode(true)));
            await assert.rejects(new KlookSeatSelector(page, 1280, 450).openAndVerify(generalTarget), PurchaseStop);
            assert.equal(await page.locator("body").getAttribute("data-confirm"), null);
        }
        await page.setContent(allocationFixture());
        await assert.rejects(
            new KlookSeatSelector(page, 1280, 450).openAndVerify({ ...generalTarget, adjacent: true }),
            /連位/,
        );
    } finally {
        await browser.close();
    }
});

test("確認前格式、張數、金額、loader或提示改變時不點確認", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        for (const change of ["format", "quantity", "price", "loading", "notice"]) {
            await page.setContent(allocationFixture());
            const selector = new KlookSeatSelector(page, 1280, 800);
            const allocation = await selector.openAndVerify(generalTarget);
            await page.evaluate(change => {
                if (change === "format")
                    document.querySelector(".seat_footer_list-TWhU8V")!.innerHTML = [22, 24]
                        .map(
                            n =>
                                `<div class="list_item-jYRAN7"><span>區 <ins>A2</ins></span><span>排 <ins>7</ins></span><span>座位 <ins>${n}</ins></span></div>`,
                        )
                        .join("");
                if (change === "quantity") document.querySelector(".con_seats-a3N26U")!.textContent = "共計1個座位";
                if (change === "price") document.querySelector(".con_price-YYYONb")!.textContent = "NT$1,280";
                if (change === "loading")
                    document
                        .querySelector(".seatModal_main-Dpti0D")!
                        .insertAdjacentHTML(
                            "beforeend",
                            '<div class="seatsio-loading-screen" style="height:20px">loading</div>',
                        );
                if (change === "notice")
                    document.body.insertAdjacentHTML(
                        "beforeend",
                        '<div role="dialog">未知提示<button>OK</button></div>',
                    );
            }, change);
            await assert.rejects(selector.confirmVerifiedSeats(generalTarget, allocation));
            assert.equal(await page.locator("body").getAttribute("data-confirm"), null);
        }
    } finally {
        await browser.close();
    }
});

test("隱藏一般票明細不能通過；確認前隱藏列、欄位、值或其祖先不點擊", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        await page.setContent(allocationFixture());
        await page.locator(".list_item-jYRAN7").evaluate(el => ((el as HTMLElement).style.visibility = "hidden"));
        await assert.rejects(new KlookSeatSelector(page, 1280, 450).openAndVerify(generalTarget), /結構未知/);
        assert.equal(await page.locator("body").getAttribute("data-confirm"), null);
        const reservedRows = [22, 24]
            .map(
                number =>
                    `<div class="list_item-jYRAN7"><span>區 <ins>A2</ins></span><span>排 <ins>7</ins></span><span>座位 <ins>${number}</ins></span></div>`,
            )
            .join("");
        for (const rows of [undefined, reservedRows]) {
            for (const [selector, property, value] of [
                [".list_item-jYRAN7", "visibility", "hidden"],
                [".list_item-jYRAN7 span", "display", "none"],
                [".list_item-jYRAN7 ins", "opacity", "0"],
                [".seat_list-BhwLqz", "opacity", "0"],
            ]) {
                await page.setContent(allocationFixture(rows === undefined ? {} : { rows }));
                const seatSelector = new KlookSeatSelector(page, 1280, 800);
                const allocation = await seatSelector.openAndVerify(generalTarget);
                await page
                    .locator(selector!)
                    .last()
                    .evaluate(
                        (el, style) => {
                            (el as HTMLElement).style.setProperty(style.property!, style.value!);
                        },
                        { property, value },
                    );
                await assert.rejects(seatSelector.confirmVerifiedSeats(generalTarget, allocation), /結構未知/);
                assert.equal(await page.locator("body").getAttribute("data-confirm"), null);
            }
        }
    } finally {
        await browser.close();
    }
});

test("配位缺少完整年份或年份不符時停止；不採用面板其他正確日期", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        for (const session of ["2027年11月15日 週日 下午5:00", "11月15日 週日 下午5:00"]) {
            const html = allocationFixture()
                .replace("2026年11月15日 週日 下午5:00", session)
                .replace(
                    '<div class="seat_list-BhwLqz">',
                    '<p>2026年11月15日 週日 下午5:00</p><div class="seat_list-BhwLqz">',
                );
            await page.setContent(html);
            await assert.rejects(
                new KlookSeatSelector(page, 1280, 450).openAndVerify(generalTarget),
                /日期不符|完整場次資料/,
            );
            assert.equal(await page.locator("body").getAttribute("data-next"), "1");
            assert.equal(await page.locator("body").getAttribute("data-confirm"), null);
        }
    } finally {
        await browser.close();
    }
});

test("非對號區域不限名稱；保留配位內容並在確認前拒絕區域改變", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
        // 票種與區域可不同，單張與多張都以兩處張數核對
        for (const [group, quantity] of [
            ["PGA", 1],
            ["一般 票", 2],
            ["自由入場", 2],
        ] as const) {
            const wanted = { ...generalTarget, quantity };
            await page.setContent(
                allocationFixture({
                    rows: `<div class="list_item-jYRAN7"><span>區 <ins>${group}</ins></span></div>`,
                    selected: `已選${quantity}個座位`,
                    total: `共計${quantity}個座位`,
                    price: `NT$${1280 * quantity}`,
                }),
            );
            const selector = new KlookSeatSelector(page, 1280, 1000);
            const allocation = await selector.openAndVerify(wanted);
            assert.deepEqual(allocation, { kind: "general", group, quantity });
            assert.equal(await page.locator("body").getAttribute("data-next"), "1");
            assert.equal(await page.locator("body").getAttribute("data-confirm"), null);

            // 同樣合法的另一個區域仍不能取代已核對結果
            await page.locator(".list_item-jYRAN7 ins").evaluate(el => {
                el.textContent = "另一區";
            });
            await assert.rejects(selector.confirmVerifiedSeats(wanted, allocation), /配位結果已改變/);
            assert.equal(await page.locator("body").getAttribute("data-confirm"), null);

            // 恢復原資料後，只執行一次確認
            await page.locator(".list_item-jYRAN7 ins").evaluate((el, value) => {
                el.textContent = value;
            }, group);
            await selector.confirmVerifiedSeats(wanted, allocation);
            assert.equal(await page.locator("body").getAttribute("data-confirm"), "1");
        }
    } finally {
        await browser.close();
    }
});
