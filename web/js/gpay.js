// Google Pay in its TEST environment for the AP2 payment step: the real Google Pay sheet with Google's test cards, no
// money moves and no merchant account is needed. The token it returns goes to the server only to be hashed into the
// Payment Mandate's instrument; nothing is charged.
let client = null, ready = null;

/** Loads Google Pay's script once (call early, so Pay opens inside the tap). */
export function preload() {
  ready ??= new Promise(resolve => {
    if (window.google?.payments?.api) return resolve(true);
    const s = document.createElement("script");
    s.src = "https://pay.google.com/gp/p/js/pay.js";
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.append(s);
  }).then(async ok => {
    if (!ok) return false;
    client = new google.payments.api.PaymentsClient({ environment: "TEST" });
    const r = await client.isReadyToPay({ apiVersion: 2, apiVersionMinor: 0, allowedPaymentMethods: [CARD] }).catch(() => ({ result: false }));
    return !!r.result;
  });
  return ready;
}

const CARD = { type: "CARD", parameters: { allowedAuthMethods: ["PAN_ONLY", "CRYPTOGRAM_3DS"], allowedCardNetworks: ["VISA", "MASTERCARD", "AMEX", "DISCOVER"] },
  tokenizationSpecification: { type: "PAYMENT_GATEWAY", parameters: { gateway: "example", gatewayMerchantId: "exampleGatewayMerchantId" } } };

/** Opens the Google Pay sheet; resolves with what the Payment Mandate needs, or null if the buyer closed it. */
export async function payWithGoogle(amount, label) {
  if (!(await preload())) throw new Error("Google Pay isn't available in this browser.");
  try {
    const d = await client.loadPaymentData({ apiVersion: 2, apiVersionMinor: 0, allowedPaymentMethods: [CARD],
      merchantInfo: { merchantName: "Collab (test)" },
      transactionInfo: { totalPriceStatus: "FINAL", totalPriceLabel: label.slice(0, 40), totalPrice: amount.toFixed(2), currencyCode: "INR", countryCode: "IN" } });
    const m = d.paymentMethodData;
    return { token: m.tokenizationData.token, network: m.info?.cardNetwork, description: m.description };
  } catch (e) {
    if (e?.statusCode === "CANCELED") return null;
    throw new Error(e?.statusMessage || "Google Pay didn't complete.");
  }
}
