import test from "node:test";
import assert from "node:assert/strict";

import { toRenderableWeixinQrSrc } from "./weixinQr.ts";

test("converts a WeChat QR login URL into an embeddable image src", async () => {
  const result = await toRenderableWeixinQrSrc(
    "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=fa0e6c8c77c8f3ba6868d27c55b98ea5&bot_type=3",
  );

  assert.equal(typeof result, "string");
  assert.match(result, /^data:image\/(png|svg\+xml);/);
});
