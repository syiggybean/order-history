import { useLoaderData } from "react-router";
import { CameraError, pickPhoneSession } from "../camera.server";
import { MobilePick } from "../components/camera/MobilePick";

// Picking a batch on a phone, opened from the pick list's QR code. The link's
// secret key is the only sign-in.

export const meta = () => [{ title: "Pick · MonkeyBean" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }) => {
  const k = new URL(request.url).searchParams.get("k") ?? "";
  try {
    const { user } = await pickPhoneSession(k);
    return { ok: true, k, userName: user.name };
  } catch (e) {
    if (!(e instanceof CameraError)) console.error("[pick-mobile]", e);
    return { ok: false, error: e instanceof CameraError ? e.message : "Something went wrong. Open it again from the batch's pick list." };
  }
};

export default function PickMobilePage() {
  const data = useLoaderData();
  if (!data.ok)
    return (
      <div style={{ fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", padding: "24px", maxWidth: "560px", margin: "0 auto", color: "#1a1a1a" }}>
        <h1 style={{ fontSize: "22px" }}>Pick</h1>
        <p>{data.error}</p>
      </div>
    );
  return <MobilePick k={data.k} userName={data.userName} />;
}
