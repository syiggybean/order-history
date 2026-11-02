import { useLoaderData } from "react-router";
import { CameraError, cameraState } from "../camera.server";
import { PackCamera } from "../components/camera/PackCamera";

// The pack camera window: opened from the pack bench (its own window, because
// Shopify's admin doesn't give embedded apps the camera). The link's secret key
// is the only sign-in.

export const meta = () => [{ title: "Pack camera · MonkeyBean" }, { name: "robots", content: "noindex" }];

export const loader = async ({ request }) => {
  const k = new URL(request.url).searchParams.get("k") ?? "";
  try {
    const state = await cameraState(k);
    return { ok: true, k, userName: state.userName };
  } catch (e) {
    if (!(e instanceof CameraError)) console.error("[pack-camera]", e);
    return { ok: false, error: e instanceof CameraError ? e.message : "Something went wrong. Open the camera again from the pack bench." };
  }
};

export default function PackCameraPage() {
  const data = useLoaderData();
  if (!data.ok)
    return (
      <div style={{ fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", padding: "40px", maxWidth: "560px", margin: "0 auto", color: "#1a1a1a" }}>
        <h1 style={{ fontSize: "22px" }}>Pack camera</h1>
        <p>{data.error}</p>
      </div>
    );
  return <PackCamera k={data.k} userName={data.userName} />;
}
