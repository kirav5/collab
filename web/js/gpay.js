// Google Pay in its TEST environment for the AP2 payment step: the real Google Pay sheet with Google's test cards, no
// money moves and no merchant account is needed. The token it returns goes to the server only to be hashed into the
// Payment Mandate's instrument; nothing is charged.
let client = null, ready = null;
/** true once Google Pay can open here; false where it can't (then the button isn't offered); null while checking. */
export const gpay = { available: null };

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
  }).then(ok => { gpay.available = ok; return ok; });
  return ready;
}

/**
 * Opens the sheet now, inside the tap: browsers (Safari above all, and installed apps) only let a payment window open
 * from the tap itself, so nothing may be awaited before this call. Google Pay must already be loaded (preload).
 */
export function openGooglePay(amount, label, currency = "INR") {
  if (!client || gpay.available !== true) return Promise.reject(new Error(gpay.available === false ? "Google Pay isn't available in this browser — use Pay instead." : "Google Pay is still loading — tap again in a moment."));
  return client.loadPaymentData({ apiVersion: 2, apiVersionMinor: 0, allowedPaymentMethods: [CARD],
    merchantInfo: { merchantName: "Collab" },
    transactionInfo: { totalPriceStatus: "FINAL", totalPriceLabel: label.slice(0, 40), totalPrice: amount.toFixed(2), currencyCode: currency, countryCode: currency === "USD" ? "US" : "IN" } })
    .then(d => { const m = d.paymentMethodData; return { token: m.tokenizationData.token, network: m.info?.cardNetwork, description: m.description }; })
    .catch(e => { if (e?.statusCode === "CANCELED") return null; throw new Error(e?.statusMessage || "Google Pay didn't complete."); });
}

const CARD = { type: "CARD", parameters: { allowedAuthMethods: ["PAN_ONLY", "CRYPTOGRAM_3DS"], allowedCardNetworks: ["VISA", "MASTERCARD", "AMEX", "DISCOVER"] },
  tokenizationSpecification: { type: "PAYMENT_GATEWAY", parameters: { gateway: "example", gatewayMerchantId: "exampleGatewayMerchantId" } } };

/** Opens the Google Pay sheet; resolves with what the Payment Mandate needs, or null if the buyer closed it. */
export async function payWithGoogle(amount, label, currency = "INR") {
  if (!(await preload())) throw new Error("Google Pay isn't available in this browser.");
  try {
    const d = await client.loadPaymentData({ apiVersion: 2, apiVersionMinor: 0, allowedPaymentMethods: [CARD],
      merchantInfo: { merchantName: "Collab" },
      transactionInfo: { totalPriceStatus: "FINAL", totalPriceLabel: label.slice(0, 40), totalPrice: amount.toFixed(2), currencyCode: currency, countryCode: currency === "USD" ? "US" : "IN" } });
    const m = d.paymentMethodData;
    return { token: m.tokenizationData.token, network: m.info?.cardNetwork, description: m.description };
  } catch (e) {
    if (e?.statusCode === "CANCELED") return null;
    throw new Error(e?.statusMessage || "Google Pay didn't complete.");
  }
}
