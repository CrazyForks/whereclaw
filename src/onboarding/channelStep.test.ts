import test from "node:test";
import assert from "node:assert/strict";

import { getChannelContinueButtonState } from "./channelStep.ts";

test("defaults to disabled when no channel is selected", () => {
  const result = getChannelContinueButtonState({
    selectedChannel: null,
    qqAppId: "",
    qqAppSecret: "",
    isApplyingInitialSetup: false,
    isStartingWeixinLogin: false,
    isWaitingForWeixinLogin: false,
  });

  assert.equal(result.disabled, true);
  assert.equal(result.showLoading, false);
});

test("allows continue for weixin without qq credentials", () => {
  const result = getChannelContinueButtonState({
    selectedChannel: "weixin",
    qqAppId: "",
    qqAppSecret: "",
    isApplyingInitialSetup: false,
    isStartingWeixinLogin: false,
    isWaitingForWeixinLogin: false,
  });

  assert.equal(result.disabled, false);
  assert.equal(result.showLoading, false);
});

test("requires qq credentials when qq is selected", () => {
  const result = getChannelContinueButtonState({
    selectedChannel: "qq",
    qqAppId: "demo-app",
    qqAppSecret: "",
    isApplyingInitialSetup: false,
    isStartingWeixinLogin: false,
    isWaitingForWeixinLogin: false,
  });

  assert.equal(result.disabled, true);
  assert.equal(result.showLoading, false);
});

test("shows loading while weixin login is in progress", () => {
  const result = getChannelContinueButtonState({
    selectedChannel: "weixin",
    qqAppId: "",
    qqAppSecret: "",
    isApplyingInitialSetup: false,
    isStartingWeixinLogin: true,
    isWaitingForWeixinLogin: false,
  });

  assert.equal(result.disabled, true);
  assert.equal(result.showLoading, true);
});
