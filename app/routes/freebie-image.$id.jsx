import { getImage } from "../freebies.server";

// A freebie's photo, for the product page (public, like any product image)
export const loader = async ({ params }) => {
  const img = /^\d+$/.test(params.id ?? "") ? await getImage(params.id) : null;
  if (!img) return new Response("Not found", { status: 404 });
  return new Response(img.data, {
    headers: {
      "Content-Type": img.contentType,
      // A new photo gets a new address, so this one never changes
      "Cache-Control": "public, max-age=31536000, immutable",
      "Access-Control-Allow-Origin": "*",
    },
  });
};
