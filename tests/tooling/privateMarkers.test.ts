import assert from "node:assert/strict";
import { test } from "node:test";
import { privateFixtureMarkers } from "../fixtures/privateMarkers.js";

test("隱私檢查不誤判耗時與 ID，但仍拒絕完整的虛構會員與私人內容", () => {
    assert.doesNotMatch(JSON.stringify({ elapsedMs: 10987, id: "random-0987-id" }), privateFixtureMarkers);
    for (const value of ["0987***654", "PRIVATE_INFORMATION_MARKER", "PRIVATE_DIALOG", "PRIVATE_PASSWORD"]) {
        assert.match(JSON.stringify({ message: value }), privateFixtureMarkers);
    }
});
