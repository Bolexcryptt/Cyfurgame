import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
    calculateCreditsFromTokenAmountRaw,
    calculateWithdrawalTokenAmountRaw
} = require("../server/lib/withdrawals.js");

test("withdrawal conversion keeps the documented CYFUR credit rate and integer math", () => {
    assert.equal(calculateWithdrawalTokenAmountRaw("10000", 8), "100000000");
    assert.equal(calculateWithdrawalTokenAmountRaw("1", 8), "10000");
    assert.equal(calculateCreditsFromTokenAmountRaw("100000000", 8), "10000");
    assert.equal(calculateCreditsFromTokenAmountRaw("10000", 8), "1");
});

test("withdrawal validation rejects invalid or non-convertible amounts", () => {
    assert.throws(() => calculateWithdrawalTokenAmountRaw("0", 8), /greater than zero/i);
    assert.throws(() => calculateWithdrawalTokenAmountRaw("1", -1), /decimals/i);
    assert.throws(() => calculateCreditsFromTokenAmountRaw("0", 8), /greater than zero/i);
    assert.throws(() => calculateWithdrawalTokenAmountRaw("abc", 8), /positive integer string/i);
});
