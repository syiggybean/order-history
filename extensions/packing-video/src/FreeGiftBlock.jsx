import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

// "Free gift" under the items on the order page in the customer's account.
// Asks MonkeyBean (with the customer's session token) which freebies came with
// this order of theirs; shows nothing otherwise.

const APP_URL = "https://order-history-production.up.railway.app";

export default async () => {
  render(<FreeGift />, document.body);
};

function FreeGift() {
  const [gifts, setGifts] = useState([]);
  const orderId = shopify.order?.value?.id;

  useEffect(() => {
    let current = true;
    (async () => {
      if (!orderId) return;
      try {
        const token = await shopify.sessionToken.get();
        const res = await fetch(`${APP_URL}/freebies/customer?orderId=${encodeURIComponent(orderId)}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const body = await res.json();
        if (current) setGifts(Array.isArray(body.gifts) ? body.gifts : []);
      } catch {
        if (current) setGifts([]);
      }
    })();
    return () => {
      current = false;
    };
  }, [orderId]);

  if (!gifts.length) return null;

  return (
    <s-section heading={gifts.length === 1 ? "Free gift with this order" : "Free gifts with this order"}>
      <s-stack direction="block" gap="base">
        {gifts.map((g, i) => (
          <s-stack key={i} direction="inline" gap="base" alignItems="center">
            {g.imageUrl && (
              <s-box inlineSize="64px" blockSize="64px">
                <s-image src={g.imageUrl} alt={g.title} aspectRatio="1" objectFit="cover" borderRadius="base" />
              </s-box>
            )}
            <s-stack direction="block" gap="small-200">
              <s-text type="strong">
                🎁 {g.title}
                {g.quantity > 1 ? ` × ${g.quantity}` : ""}
              </s-text>
              {g.description ? <s-text color="subdued">{g.description}</s-text> : null}
              <s-text color="subdued">Packed with your order, free.</s-text>
            </s-stack>
          </s-stack>
        ))}
      </s-stack>
    </s-section>
  );
}
