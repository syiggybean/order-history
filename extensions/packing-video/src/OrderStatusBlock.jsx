import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// "Your packing video" on the order page in the customer's account. Asks
// MonkeyBean (with the customer's session token) whether staff made a clip of
// this order for this customer; shows nothing otherwise.

const APP_URL = "https://order-history-production.up.railway.app";

export default async () => {
  render(<PackingVideo />, document.body);
};

function PackingVideo() {
  const [clip, setClip] = useState(null);
  const orderId = shopify.order?.value?.id;

  useEffect(() => {
    let current = true;
    (async () => {
      if (!orderId) return;
      try {
        const token = await shopify.sessionToken.get();
        const res = await fetch(`${APP_URL}/packcam/customer?orderId=${encodeURIComponent(orderId)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const body = await res.json();
        if (current) setClip(body.clip ?? null);
      } catch {
        if (current) setClip(null);
      }
    })();
    return () => {
      current = false;
    };
  }, [orderId]);

  if (!clip?.watchUrl || new Date(clip.expiresAt) <= new Date()) return null;

  return (
    <s-section heading="Your packing video">
      <s-stack direction="block" gap="base">
        <s-text>See how we packed your order {clip.orderName}.</s-text>
        <s-button href={clip.watchUrl} target="_blank" variant="primary">
          Watch packing video
        </s-button>
        <s-text color="subdued">Available until {new Date(clip.expiresAt).toLocaleDateString()}.</s-text>
      </s-stack>
    </s-section>
  );
}
