export function NoAccess({ feature }) {
  return (
    <s-page heading={feature}>
      <s-section>
        <s-paragraph>
          You don't have access to {feature} yet. Ask an admin of this app to give you access on the Permissions page.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}
