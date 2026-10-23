import { createContext, useContext } from "react";
import { DEFAULT_METHOD_RULES, METHOD_KINDS, methodKind } from "./methods";

// The shop's rules for which checkout shipping options are cheapest / fastest / buyer-selected
export const MethodRulesContext = createContext(DEFAULT_METHOD_RULES);

// The shipping method as a colored badge (green cheapest, blue fastest, pink buyer-selected)
export function MethodBadge({ method, size = "normal" }) {
  const rules = useContext(MethodRulesContext);
  if (!method) return null;
  const kind = methodKind(method, rules);
  const k = kind ? METHOD_KINDS[kind] : null;
  const pad = size === "small" ? "0 7px" : "1px 9px";
  return (
    <span
      title={k ? `${k.label} shipping` : "Shipping method"}
      style={{
        display: "inline-block",
        padding: pad,
        borderRadius: "999px",
        fontSize: size === "small" ? "11px" : "12px",
        fontWeight: 600,
        lineHeight: 1.6,
        whiteSpace: "nowrap",
        background: k?.bg ?? "#f1f1f1",
        color: k?.fg ?? "#4a4a4a",
        border: `1px solid ${k?.border ?? "#dcdcdc"}`,
      }}
    >
      {method}
    </span>
  );
}
