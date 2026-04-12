import QRCode from "qrcode";

export async function toRenderableWeixinQrSrc(qrUrl: string): Promise<string> {
  const normalizedQrUrl = qrUrl.trim();
  if (normalizedQrUrl.length === 0) {
    return "";
  }

  return QRCode.toDataURL(normalizedQrUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
  });
}
