import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDateOption, matchesDateOption } from "../src/platforms/klook/eventDate.js";

test("日期選項解析月日與明確年份，不從星期補年份", () => {
    for (const text of ["11月2日(週一)", "１１月０２日（星期一）", "11 月 2 日"]) {
        assert.deepEqual(parseDateOption(text), { year: null, month: 11, day: 2 });
        assert.equal(matchesDateOption(parseDateOption(text), "2026-11-02"), true);
    }
    for (const text of ["2026年11月2日", "2026/11/02（一）", "2026-11-02", "2026.11.02"]) {
        assert.deepEqual(parseDateOption(text), { year: 2026, month: 11, day: 2 });
        assert.equal(matchesDateOption(parseDateOption(text), "2027-11-02"), false);
    }
    assert.equal(matchesDateOption(parseDateOption("11月15日(週日)"), "2026-11-02"), false);
    assert.equal(parseDateOption("2月29日").year, null);
});

test("拒絕不存在、歧義、區間及任意文字中的日期", () => {
    for (const text of ["2026/2/29", "2月30日", "13月1日", "0月15日", "11月0日", "0000/11/15"]) {
        assert.throws(() => parseDateOption(text), /日期不存在/);
    }
    for (const text of ["11/02", "11/2/2026", "2026/11-02", "12026/11/02", "11月2日-3日", "11月2日、11月3日", "開賣2026/11/02", "2026/11/02 19:30"]) {
        assert.throws(() => parseDateOption(text), /格式無法辨識/);
    }
});
