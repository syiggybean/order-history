import { Form, useLoaderData } from "react-router";
import db from "../db.server";
import { unsubscribe } from "../preorder-notify.server";

// Unsubscribe link in notification emails. Opening the link asks to confirm
// (so link scanners don't unsubscribe people); mail apps' one-click
// unsubscribe sends a POST, which unsubscribes straight away.

export const loader = async ({ params }) => {
  const sub = await db.notifySubscriber.findUnique({ where: { token: String(params.token ?? "") } });
  return { found: Boolean(sub), done: Boolean(sub?.unsubscribedAt) };
};

export const action = async ({ params }) => {
  const sub = await unsubscribe(String(params.token ?? ""));
  return { done: Boolean(sub) };
};

const page = {
  fontFamily: "Helvetica, Arial, sans-serif",
  maxWidth: "440px",
  margin: "60px auto",
  padding: "28px",
  borderRadius: "14px",
  background: "#fff",
  boxShadow: "0 8px 24px rgba(0,0,0,.08)",
  color: "#1a1a1a",
  textAlign: "center",
};

export default function Unsubscribe() {
  const { found, done } = useLoaderData();
  return (
    <div style={{ background: "#FBACBB", minHeight: "100vh", padding: "1px 16px" }}>
      <div style={page}>
        {!found ? (
          <p>This link isn't valid anymore.</p>
        ) : done ? (
          <>
            <h1 style={{ fontSize: "20px" }}>You're unsubscribed</h1>
            <p>You won't get any more pre-order emails from us.</p>
          </>
        ) : (
          <Form method="post">
            <h1 style={{ fontSize: "20px" }}>Stop pre-order emails?</h1>
            <p>You won't hear from us about pre-orders opening, restocks or closing dates.</p>
            <button
              type="submit"
              style={{ marginTop: "12px", background: "#1a1a1a", color: "#fff", border: 0, borderRadius: "999px", padding: "12px 24px", fontSize: "15px", cursor: "pointer" }}
            >
              Unsubscribe
            </button>
          </Form>
        )}
      </div>
    </div>
  );
}
